import path from 'node:path';
import XLSX from 'xlsx';
import { sanitizeCell } from '../utils/csv.js';

function normalizeRow(raw) {
  const row = {};
  for (const [k, v] of Object.entries(raw || {})) {
    row[String(k || '').trim().toLowerCase()] = v;
  }

  const student = String(
    row.student || row['student_name'] || row.name || row['学生'] || row['姓名'] || '',
  ).trim();
  const className = String(row.class || row['班级'] || row['class_name'] || '未分班').trim() || '未分班';
  const scoreRaw = row.score || row['分数'] || row['成绩'] || row['total_score'];
  const score = Number(scoreRaw);
  if (!student || Number.isNaN(score)) {
    return null;
  }
  return {
    student,
    className,
    score
  };
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values) {
  if (values.length <= 1) {
    return 0;
  }
  const avg = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return [];
  }
  const headers = lines[0].split(',').map((s) => s.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const record = {};
    headers.forEach((h, i) => {
      record[h] = cols[i] ?? '';
    });
    rows.push(record);
  }
  return rows;
}

function toCsv(headers, rows) {
  const esc = (v) => {
    const s = sanitizeCell(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const out = [headers.map(esc).join(',')];
  for (const row of rows) {
    out.push(headers.map((h) => esc(row[h])).join(','));
  }
  return out.join('\n');
}

function summarize(records) {
  const byStudent = new Map();
  const byClass = new Map();

  for (const r of records) {
    if (!byStudent.has(r.student)) {
      byStudent.set(r.student, []);
    }
    byStudent.get(r.student).push(r.score);

    if (!byClass.has(r.className)) {
      byClass.set(r.className, []);
    }
    byClass.get(r.className).push(r.score);
  }

  const studentRows = [];
  for (const [student, scores] of byStudent) {
    studentRows.push({
      student,
      exam_count: scores.length,
      avg_score: mean(scores).toFixed(2),
      max_score: Math.max(...scores),
      min_score: Math.min(...scores)
    });
  }

  const classRows = [];
  for (const [className, scores] of byClass) {
    classRows.push({
      class_name: className,
      student_count: scores.length,
      avg_score: mean(scores).toFixed(2),
      max_score: Math.max(...scores),
      min_score: Math.min(...scores),
      stddev: stddev(scores).toFixed(2)
    });
  }

  studentRows.sort((a, b) => Number(b.avg_score) - Number(a.avg_score));
  classRows.sort((a, b) => Number(b.avg_score) - Number(a.avg_score));

  const all = records.map((r) => r.score);
  const summary = {
    total_records: records.length,
    overall_avg: mean(all).toFixed(2),
    overall_max: Math.max(...all),
    overall_min: Math.min(...all)
  };

  return {
    summary,
    studentRows,
    classRows
  };
}

export class GradesAgent {
  constructor({ db, storage, modelClient, publicBaseUrl }) {
    this.db = db;
    this.storage = storage;
    this.modelClient = modelClient;
    this.publicBaseUrl = publicBaseUrl;
  }

  async loadRecordsFromFile(filePath, ext) {
    if (ext === '.csv') {
      const buf = await this.storage.readFile(filePath);
      return parseCsv(buf.toString('utf8'));
    }

    if (ext === '.xlsx' || ext === '.xls') {
      const wb = XLSX.readFile(filePath);
      const firstSheet = wb.SheetNames[0];
      return XLSX.utils.sheet_to_json(wb.Sheets[firstSheet]);
    }

    throw new Error('仅支持 csv/xlsx/xls');
  }

  async recordsFromImages(files) {
    const all = [];
    for (const file of files) {
      const text = await this.modelClient.extractTextFromImage(file.path);
      // 约定模型转写为 CSV 行：student,class,score
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const line of lines) {
        const cols = line.split(',').map((v) => v.trim());
        if (cols.length < 3) {
          continue;
        }
        all.push({ student: cols[0], class: cols[1], score: Number(cols[2]) });
      }
    }
    return all;
  }

  async run(job) {
    const { id: jobId, user_id: userId, input } = job;
    this.db.updateJob({ jobId, status: 'processing' });

    let rawRows = [];
    if (input.file_id) {
      const file = this.db.getFileForUser({ userId, fileId: input.file_id });
      if (!file) {
        throw new Error('成绩文件不存在');
      }
      rawRows = await this.loadRecordsFromFile(file.path, path.extname(file.filename).toLowerCase());
    } else if (input.upload_id) {
      const upload = this.db.getUploadWithFiles({ userId, uploadId: input.upload_id });
      if (!upload || upload.files.length === 0) {
        throw new Error('图片上传不存在');
      }
      rawRows = await this.recordsFromImages(upload.files);
    } else {
      throw new Error('缺少 file_id 或 upload_id');
    }

    const records = rawRows
      .map((row) => normalizeRow(row))
      .filter(Boolean);

    if (records.length === 0) {
      throw new Error('无法识别有效成绩数据。请保证列名包含 student/name/姓名、class/班级、score/成绩。');
    }

    const { summary, studentRows, classRows } = summarize(records);

    const studentCsv = toCsv(['student', 'exam_count', 'avg_score', 'max_score', 'min_score'], studentRows);
    const classCsv = toCsv(
      ['class_name', 'student_count', 'avg_score', 'max_score', 'min_score', 'stddev'],
      classRows,
    );

    const csvContent = `# summary\nmetric,value\nrecords,${summary.total_records}\noverall_avg,${summary.overall_avg}\noverall_max,${summary.overall_max}\noverall_min,${summary.overall_min}\n\n# by_student\n${studentCsv}\n\n# by_class\n${classCsv}\n`;

    const csvSaved = await this.storage.writeText({
      userId,
      category: 'outputs',
      originalName: `grades-${jobId}.csv`,
      text: csvContent
    });
    const csvBuf = await this.storage.readFile(csvSaved.path);
    const csvFileId = this.db.createFile({
      userId,
      kind: 'grades_csv',
      filename: csvSaved.filename,
      mime: 'text/csv',
      size: csvBuf.length,
      filePath: csvSaved.path
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(studentRows), 'by_student');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(classRows), 'by_class');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([summary]), 'summary');

    const xlsxSaved = await this.storage.saveBuffer({
      userId,
      category: 'outputs',
      originalName: `grades-${jobId}.xlsx`,
      buffer: Buffer.alloc(0)
    });
    XLSX.writeFile(wb, xlsxSaved.path);
    const xlsxBuf = await this.storage.readFile(xlsxSaved.path);
    const xlsxFileId = this.db.createFile({
      userId,
      kind: 'grades_xlsx',
      filename: xlsxSaved.filename,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: xlsxBuf.length,
      filePath: xlsxSaved.path
    });

    this.db.updateJob({
      jobId,
      status: 'done',
      result: {
        summary,
        csv_file_id: csvFileId,
        xlsx_file_id: xlsxFileId,
        csv_download_url: `${this.publicBaseUrl}/download/${csvFileId}`,
        xlsx_download_url: `${this.publicBaseUrl}/download/${xlsxFileId}`
      }
    });
  }
}
