import XLSX from 'xlsx';
import { sanitizeCell, csvEscape } from '../utils/csv.js';
import { groupPhotosByStudent } from './quiz-agent.js';

export class EssayAgent {
  constructor({ db, storage, modelClient, publicBaseUrl }) {
    this.db = db;
    this.storage = storage;
    this.modelClient = modelClient;
    this.publicBaseUrl = publicBaseUrl;
  }

  async run(job) {
    if (job.type === 'essay_review') {
      return this.processEssayBatch(job);
    }
    throw new Error(`EssayAgent: 未知任务类型 ${job.type}`);
  }

  async processEssayBatch(job) {
    const { id: jobId, user_id: userId, input } = job;

    const resultAcc = {
      progress: '',
      result_id: null,
      summary: null,
      low_confidence_items: [],
      failed_students: [],
      partial: false,
      csv_download_url: null,
      xlsx_download_url: null,
    };

    this.db.updateJob({ jobId, status: 'processing', result: resultAcc });

    // 1. Load upload files
    const upload = this.db.getUploadWithFiles({ userId, uploadId: input.upload_id });
    if (!upload || upload.files.length === 0) {
      throw new Error('未找到上传的作文图片');
    }

    // 2. Create essay_result
    const pagesPerEssay = input.pages_per_essay || 1;
    const topic = input.topic || '';
    const resultId = this.db.createEssayResult({
      userId,
      topic,
      pagesPerEssay,
      sourceJobId: jobId,
    });
    resultAcc.result_id = resultId;

    // 3. Group photos by student
    const studentGroups = groupPhotosByStudent(upload.files, pagesPerEssay);
    const totalStudents = studentGroups.length;
    const allStudentReviews = [];
    const gradeStartTime = Date.now();

    // 4. Process each student
    for (let idx = 0; idx < studentGroups.length; idx++) {
      const group = studentGroups[idx];
      const imagePaths = group.map((f) => f.path);

      const elapsed = (Date.now() - gradeStartTime) / 1000;
      const avgPerStudent = idx > 0 ? elapsed / idx : 8;
      const remaining = Math.max(0, Math.round(avgPerStudent * (totalStudents - idx - 1)));
      resultAcc.progress = `批改中 ${idx + 1}/${totalStudents}（约剩 ${remaining} 秒）`;
      this.db.updateJob({ jobId, status: 'processing', result: resultAcc });

      try {
        const review = await this.modelClient.reviewEssayFromImages({
          imagePaths,
          topic,
          request: input.request || '',
        });

        const studentName = review.student_name || `学生${idx + 1}`;
        const spellingCount = Array.isArray(review.spelling_errors) ? review.spelling_errors.length : 0;
        const grammarCount = Array.isArray(review.grammar_issues) ? review.grammar_issues.length : 0;

        this.db.insertEssayResultItem({
          resultId,
          studentName,
          estimatedScore: review.estimated_score,
          fullScore: review.full_score,
          spellingCount,
          grammarCount,
          topicMatchScore: review.topic_match_score,
          transcription: review.transcription || '',
          reviewJson: JSON.stringify(review),
        });

        allStudentReviews.push({ studentName, review });
      } catch (err) {
        resultAcc.failed_students.push({
          photo_index: idx * pagesPerEssay,
          reason: err?.message || '作文批改失败',
        });
      }
    }

    // 5. Guard: all students failed
    if (allStudentReviews.length === 0) {
      resultAcc.progress = '批改失败';
      resultAcc.partial = true;
      resultAcc.summary = { student_count: 0 };
      this.db.updateJob({ jobId, status: 'done', result: resultAcc });
      return;
    }

    // 6. Generate report
    const { csvFileId, xlsxFileId, summary } = await this.generateReport({
      userId,
      jobId,
      resultId,
      allStudentReviews,
    });

    // 6. Final job update
    resultAcc.summary = summary;
    resultAcc.partial = resultAcc.failed_students.length > 0;
    resultAcc.csv_download_url = `${this.publicBaseUrl}/download/${csvFileId}`;
    resultAcc.xlsx_download_url = `${this.publicBaseUrl}/download/${xlsxFileId}`;
    resultAcc.progress = '完成';

    this.db.updateJob({ jobId, status: 'done', result: resultAcc });
  }

  async generateReport({ userId, jobId, resultId, allStudentReviews }) {
    // Sheet 1: 成绩总览
    const overviewRows = allStudentReviews.map((s, idx) => {
      const r = s.review;
      return {
        姓名: sanitizeCell(s.studentName),
        得分: r.estimated_score ?? '-',
        满分: r.full_score ?? '-',
        '得分率': r.estimated_score != null && r.full_score
          ? `${((r.estimated_score / r.full_score) * 100).toFixed(1)}%`
          : '-',
        拼写错误数: Array.isArray(r.spelling_errors) ? r.spelling_errors.length : 0,
        语法错误数: Array.isArray(r.grammar_issues) ? r.grammar_issues.length : 0,
        主题匹配度: r.topic_match_score ?? '-',
        排名: 0,
      };
    });
    overviewRows.sort((a, b) => {
      const sa = typeof a['得分'] === 'number' ? a['得分'] : -1;
      const sb = typeof b['得分'] === 'number' ? b['得分'] : -1;
      return sb - sa;
    });
    overviewRows.forEach((row, i) => { row.排名 = i + 1; });

    // Sheet 2: 逐人详细反馈
    const feedbackRows = allStudentReviews.map((s) => {
      const r = s.review;
      const score = r.estimated_score != null ? `${r.estimated_score}/${r.full_score || '?'}` : '未评分';
      const spellingList = (r.spelling_errors || [])
        .map((e) => `${e.original} → ${e.suggestion}`)
        .join('；') || '无';
      const grammarList = (r.grammar_issues || [])
        .map((e) => `${e.original} → ${e.suggestion}`)
        .join('；') || '无';
      const mismatches = (r.requirement_mismatches || []).join('；') || '无';
      return {
        姓名: sanitizeCell(s.studentName),
        得分: score,
        总体反馈: sanitizeCell(r.overall_feedback || ''),
        '与要求不符': sanitizeCell(mismatches),
        拼写问题: sanitizeCell(spellingList),
        语法问题: sanitizeCell(grammarList),
      };
    });

    // Sheet 3: 常见错误统计
    const spellingCounts = new Map();
    const grammarCounts = new Map();
    for (const s of allStudentReviews) {
      for (const e of s.review.spelling_errors || []) {
        const key = `spelling:${e.original}:${e.suggestion}`;
        const entry = spellingCounts.get(key) || { count: 0, students: [], original: e.original, suggestion: e.suggestion };
        entry.count++;
        entry.students.push(s.studentName);
        spellingCounts.set(key, entry);
      }
      for (const e of s.review.grammar_issues || []) {
        const key = `grammar:${e.original}:${e.suggestion}`;
        const entry = grammarCounts.get(key) || { count: 0, students: [], original: e.original, suggestion: e.suggestion };
        entry.count++;
        entry.students.push(s.studentName);
        grammarCounts.set(key, entry);
      }
    }
    const errorRows = [];
    for (const [, val] of [...spellingCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
      errorRows.push({
        错误类型: '拼写',
        原文: sanitizeCell(val.original || ''),
        建议修改: sanitizeCell(val.suggestion || ''),
        出现次数: val.count,
        涉及学生: sanitizeCell(val.students.join('、')),
      });
    }
    for (const [, val] of [...grammarCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
      errorRows.push({
        错误类型: '语法',
        原文: sanitizeCell(val.original || ''),
        建议修改: sanitizeCell(val.suggestion || ''),
        出现次数: val.count,
        涉及学生: sanitizeCell(val.students.join('、')),
      });
    }

    // Write XLSX
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(overviewRows.length ? overviewRows : [{}]), '成绩总览');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(feedbackRows.length ? feedbackRows : [{}]), '逐人详细反馈');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(errorRows.length ? errorRows : [{}]), '常见错误统计');

    const xlsxSaved = await this.storage.saveBuffer({
      userId,
      category: 'outputs',
      originalName: `essay-${jobId}.xlsx`,
      buffer: Buffer.alloc(0),
    });
    XLSX.writeFile(wb, xlsxSaved.path);
    const xlsxBuf = await this.storage.readFile(xlsxSaved.path);
    const xlsxFileId = this.db.createFile({
      userId,
      kind: 'essay_xlsx',
      filename: xlsxSaved.filename,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: xlsxBuf.length,
      filePath: xlsxSaved.path,
    });

    // Write CSV (overview only)
    const csvHeaders = ['姓名', '得分', '满分', '得分率', '拼写错误数', '语法错误数', '主题匹配度', '排名'];
    const csvLines = [csvHeaders.join(',')];
    for (const row of overviewRows) {
      csvLines.push(csvHeaders.map((h) => csvEscape(row[h])).join(','));
    }
    const csvSaved = await this.storage.writeText({
      userId,
      category: 'outputs',
      originalName: `essay-${jobId}.csv`,
      text: csvLines.join('\n'),
    });
    const csvBuf = await this.storage.readFile(csvSaved.path);
    const csvFileId = this.db.createFile({
      userId,
      kind: 'essay_csv',
      filename: csvSaved.filename,
      mime: 'text/csv',
      size: csvBuf.length,
      filePath: csvSaved.path,
    });

    // Build summary
    const scores = overviewRows
      .map((r) => r['得分'])
      .filter((v) => typeof v === 'number');
    const avg = scores.length > 0 ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '0';
    const maxRow = overviewRows.find((r) => r.排名 === 1);
    const minRow = overviewRows[overviewRows.length - 1];
    const fullScore = allStudentReviews[0]?.review?.full_score || null;

    const summary = {
      student_count: allStudentReviews.length,
      average_score: avg,
      full_score: fullScore,
      max_student: maxRow?.姓名 || '',
      max_score: maxRow?.['得分'] ?? '-',
      min_student: minRow?.姓名 || '',
      min_score: minRow?.['得分'] ?? '-',
      total_spelling: overviewRows.reduce((s, r) => s + (r['拼写错误数'] || 0), 0),
      total_grammar: overviewRows.reduce((s, r) => s + (r['语法错误数'] || 0), 0),
      top_errors: errorRows.slice(0, 5).map((e) => ({
        type: e['错误类型'],
        original: e['原文'],
        suggestion: e['建议修改'],
        count: e['出现次数'],
      })),
    };

    return { csvFileId, xlsxFileId, summary };
  }
}
