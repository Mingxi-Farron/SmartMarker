import XLSX from 'xlsx';

export function parseCompactOcr(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }
  // Support both half-width | and full-width ｜
  const parts = trimmed.split(/[|｜]/).map((s) => s.trim());
  if (parts.length < 3) {
    return null;
  }

  const studentName = parts[0] || '未知';
  const studentIdNumber = parts[1] || '000000';
  const answers = [];

  for (let i = 2; i < parts.length; i++) {
    // Support both : and ：
    const match = parts[i].match(/^(\d+)\s*[:：]\s*(.+)$/);
    if (match) {
      answers.push({
        questionNumber: parseInt(match[1], 10),
        studentAnswer: match[2].trim() || '?',
      });
    }
  }

  return { studentName, studentIdNumber, answers };
}

export function compareAnswers(studentAnswers, answerKeyQuestions) {
  const keyMap = new Map();
  for (const q of answerKeyQuestions) {
    keyMap.set(q.question_number, q.correct_answer);
  }

  const results = [];
  const mismatches = [];

  for (const sa of studentAnswers) {
    const correctRaw = keyMap.get(sa.questionNumber);
    if (correctRaw === undefined) {
      results.push({ ...sa, isCorrect: false, confidence: 0.0 });
      continue;
    }
    const correct = correctRaw.trim().toLowerCase();
    const studentNorm = sa.studentAnswer.trim().toLowerCase();
    const isCorrect = studentNorm === correct;
    const isUnrecognized = sa.studentAnswer === '?';

    if (isCorrect) {
      results.push({ ...sa, isCorrect: true, confidence: 1.0 });
    } else if (isUnrecognized) {
      results.push({ ...sa, isCorrect: false, confidence: 1.0 });
    } else {
      results.push({ ...sa, isCorrect: false, confidence: 0.5 });
      mismatches.push({
        questionNumber: sa.questionNumber,
        studentAnswer: sa.studentAnswer,
        correctAnswer: correctRaw,
      });
    }
  }

  return { results, mismatches };
}

export function groupPhotosByStudent(files, pageCount) {
  const pagesPerStudent = Math.max(1, pageCount || 1);
  const groups = [];
  for (let i = 0; i < files.length; i += pagesPerStudent) {
    groups.push(files.slice(i, i + pagesPerStudent));
  }
  return groups;
}

function sanitizeCell(value) {
  const s = String(value ?? '');
  if (s.length > 0 && '=+-@\t\r'.includes(s[0])) {
    return `'${s}`;
  }
  return s;
}

function csvEscape(value) {
  const s = sanitizeCell(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export class QuizAgent {
  constructor({ db, storage, modelClient, publicBaseUrl }) {
    this.db = db;
    this.storage = storage;
    this.modelClient = modelClient;
    this.publicBaseUrl = publicBaseUrl;
  }

  async run(job) {
    const { type } = job;
    if (type === 'quiz_key') {
      return this.processAnswerKey(job);
    }
    if (type === 'quiz_grade') {
      return this.gradeStudentPapers(job);
    }
    throw new Error(`QuizAgent: 未知任务类型 ${type}`);
  }

  async processAnswerKey(job) {
    const { id: jobId, user_id: userId, input } = job;
    this.db.updateJob({ jobId, status: 'processing' });

    const upload = this.db.getUploadWithFiles({ userId, uploadId: input.upload_id });
    if (!upload || upload.files.length === 0) {
      throw new Error('未找到上传的答案图片');
    }
    const imagePaths = upload.files.map((f) => f.path);

    const vlmResult = await this.modelClient.extractAnswerKeyFromImages({
      imagePaths,
      hintText: input.hint_text || '',
    });

    if (!vlmResult.questions || vlmResult.questions.length === 0) {
      throw new Error('未识别到任何题目');
    }

    const answerKeyId = this.db.createAnswerKey({
      userId,
      title: input.title || '过关单答案',
      pageCount: vlmResult.page_count || imagePaths.length,
      sourceJobId: jobId,
    });

    this.db.bulkInsertAnswerKeyQuestions({
      answerKeyId,
      questions: vlmResult.questions.map((q) => ({
        questionNumber: q.number,
        correctAnswer: q.correct_answer || '',
        knowledgeTag: q.knowledge_tag || '',
        confidence: q.confidence != null ? q.confidence : 1.0,
      })),
    });

    const lowConfidence = vlmResult.questions.filter((q) => (q.confidence || 1) < 0.6);

    this.db.updateJob({
      jobId,
      status: 'done',
      result: {
        answer_key_id: answerKeyId,
        page_count: vlmResult.page_count || imagePaths.length,
        question_count: vlmResult.questions.length,
        questions_preview: vlmResult.questions.map((q) => ({
          number: q.number,
          correct_answer: q.correct_answer,
        })),
        low_confidence_questions: lowConfidence.map((q) => ({
          number: q.number,
          correct_answer: q.correct_answer,
          confidence: q.confidence,
        })),
      },
    });
  }

  async gradeStudentPapers(job) {
    const { id: jobId, user_id: userId, input } = job;

    // Result accumulator — all updates include full state to prevent data loss
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

    // 1. Load answer key
    const answerKeyData = this.db.getAnswerKeyWithQuestions({
      userId,
      answerKeyId: input.answer_key_id,
    });
    if (!answerKeyData) {
      throw new Error('答案未找到或无权访问');
    }
    const { answerKey, questions: answerKeyQuestions } = answerKeyData;

    // 2. Load upload files
    const upload = this.db.getUploadWithFiles({ userId, uploadId: input.upload_id });
    if (!upload || upload.files.length === 0) {
      throw new Error('未找到上传的学生答卷图片');
    }

    // 3. Create or reuse quiz_result
    let resultId;
    if (input.append_to_result_id) {
      const existing = this.db.getQuizResultForUser({ userId, resultId: input.append_to_result_id });
      if (!existing) {
        throw new Error('追加目标结果不存在');
      }
      resultId = existing.id;
    } else {
      resultId = this.db.createQuizResult({
        userId,
        answerKeyId: input.answer_key_id,
        sourceJobId: jobId,
      });
    }
    resultAcc.result_id = resultId;

    // 4. Group photos by student
    const pageCount = answerKey.page_count || 1;
    const studentGroups = groupPhotosByStudent(upload.files, pageCount);
    const totalStudents = studentGroups.length;

    // 5. Process each student
    const allStudentResults = [];

    for (let idx = 0; idx < studentGroups.length; idx++) {
      const group = studentGroups[idx];
      const imagePaths = group.map((f) => f.path);

      resultAcc.progress = `批改中 ${idx + 1}/${totalStudents}`;
      this.db.updateJob({ jobId, status: 'processing', result: resultAcc });

      try {
        // Stage 1: OCR
        const ocrText = await this.modelClient.ocrStudentAnswers({ imagePaths });
        const parsed = parseCompactOcr(ocrText);
        if (!parsed || parsed.answers.length === 0) {
          resultAcc.failed_students.push({ photo_index: idx * pageCount, reason: '无法解析 OCR 结果' });
          continue;
        }

        // Stage 2: Code-based comparison
        const { results, mismatches } = compareAnswers(parsed.answers, answerKeyQuestions);

        // Stage 3: Optional VLM verification for mismatches (batched, max 30 per call)
        let verifiedResults = results;
        if (mismatches.length > 0) {
          try {
            const BATCH_SIZE = 30;
            const allVerdicts = [];
            for (let bi = 0; bi < mismatches.length; bi += BATCH_SIZE) {
              const batch = mismatches.slice(bi, bi + BATCH_SIZE);
              const verdicts = await this.modelClient.verifyOcrMismatches({ pairs: batch });
              if (Array.isArray(verdicts)) {
                allVerdicts.push(...verdicts);
              }
            }
            if (allVerdicts.length > 0) {
              const verdictMap = new Map();
              for (const v of allVerdicts) {
                verdictMap.set(Number(v.question_number ?? v.questionNumber), v);
              }
              verifiedResults = results.map((r) => {
                const v = verdictMap.get(r.questionNumber);
                if (v) {
                  return {
                    ...r,
                    isCorrect: v.verdict === 'correct',
                    confidence: v.confidence || r.confidence,
                  };
                }
                return r;
              });
            }
          } catch {
            // Verification failed — keep code-based results
          }
        }

        // Save to DB
        this.db.bulkInsertQuizResultAnswers({
          resultId,
          answers: verifiedResults.map((r) => ({
            studentName: parsed.studentName,
            studentIdNumber: parsed.studentIdNumber,
            questionNumber: r.questionNumber,
            studentAnswer: r.studentAnswer,
            isCorrect: r.isCorrect,
            confidence: r.confidence,
          })),
        });

        allStudentResults.push({
          studentName: parsed.studentName,
          studentIdNumber: parsed.studentIdNumber,
          answers: verifiedResults,
        });
      } catch (err) {
        resultAcc.failed_students.push({
          photo_index: idx * pageCount,
          reason: err?.message || 'OCR 处理失败',
        });
      }
    }

    // 6. Generate Excel + CSV
    const { csvFileId, xlsxFileId, summary } = await this.generateReport({
      userId,
      jobId,
      resultId,
      answerKeyQuestions,
      allStudentResults,
    });

    // 7. Build low-confidence items
    const lowConfidenceItems = this.db.getLowConfidenceAnswers({ resultId, maxConfidence: 0.5 });

    // 8. Final job update
    resultAcc.summary = summary;
    resultAcc.low_confidence_items = lowConfidenceItems.map((i) => ({
      student_name: i.student_name,
      question_number: i.question_number,
      student_answer: i.student_answer,
      correct_answer: answerKeyQuestions.find((q) => q.question_number === i.question_number)?.correct_answer || '',
    }));
    resultAcc.partial = resultAcc.failed_students.length > 0;
    resultAcc.csv_download_url = `${this.publicBaseUrl}/download/${csvFileId}`;
    resultAcc.xlsx_download_url = `${this.publicBaseUrl}/download/${xlsxFileId}`;
    resultAcc.progress = '完成';

    this.db.updateJob({ jobId, status: 'done', result: resultAcc });
  }

  async generateReport({ userId, jobId, resultId, answerKeyQuestions, allStudentResults }) {
    // Sheet 1: 成绩总览
    const overviewRows = allStudentResults.map((student) => {
      const total = student.answers.length;
      const correct = student.answers.filter((a) => a.isCorrect).length;
      const wrong = student.answers.filter((a) => !a.isCorrect && a.studentAnswer !== '?').length;
      const unrecognized = student.answers.filter((a) => a.studentAnswer === '?').length;
      const scoreRate = total > 0 ? ((correct / total) * 100).toFixed(1) : '0.0';
      return {
        姓名: sanitizeCell(student.studentName),
        学号: sanitizeCell(student.studentIdNumber),
        正确: correct,
        错误: wrong,
        未识别: unrecognized,
        '得分率': `${scoreRate}%`,
        排名: 0,
      };
    });
    overviewRows.sort((a, b) => parseFloat(b['得分率']) - parseFloat(a['得分率']));
    overviewRows.forEach((row, i) => { row.排名 = i + 1; });

    // Sheet 2: 逐题矩阵
    const questionNumbers = answerKeyQuestions.map((q) => q.question_number).sort((a, b) => a - b);
    const matrixRows = allStudentResults.map((student) => {
      const row = { 姓名: sanitizeCell(student.studentName) };
      const answerMap = new Map(student.answers.map((a) => [a.questionNumber, a]));
      for (const qn of questionNumbers) {
        const a = answerMap.get(qn);
        row[`Q${qn}`] = a ? (a.isCorrect ? '✓' : sanitizeCell(a.studentAnswer)) : '';
      }
      return row;
    });

    // Sheet 3: 错题统计
    const questionStats = questionNumbers.map((qn) => {
      const keyQ = answerKeyQuestions.find((q) => q.question_number === qn);
      const studentAnswersForQ = allStudentResults
        .map((s) => s.answers.find((a) => a.questionNumber === qn))
        .filter(Boolean);
      const total = studentAnswersForQ.length;
      const wrongAnswers = studentAnswersForQ.filter((a) => !a.isCorrect);
      const errorRate = total > 0 ? ((wrongAnswers.length / total) * 100).toFixed(1) : '0.0';

      const wrongCounts = new Map();
      for (const wa of wrongAnswers) {
        wrongCounts.set(wa.studentAnswer, (wrongCounts.get(wa.studentAnswer) || 0) + 1);
      }
      const commonErrors = [...wrongCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([answer, count]) => `${answer}(${count})`)
        .join(', ');

      return {
        题号: qn,
        正确答案: sanitizeCell(keyQ?.correct_answer || ''),
        知识点: sanitizeCell(keyQ?.knowledge_tag || ''),
        '错误率': `${errorRate}%`,
        常见错误: sanitizeCell(commonErrors),
      };
    });

    // Sheet 4: 逐人反馈卡
    const feedbackRows = allStudentResults.map((student) => {
      const total = student.answers.length;
      const correct = student.answers.filter((a) => a.isCorrect).length;
      const wrongAnswers = student.answers.filter((a) => !a.isCorrect);
      const lines = [
        `${student.studentName}（${student.studentIdNumber}）- 得分：${correct}/${total}（${total > 0 ? ((correct / total) * 100).toFixed(0) : 0}%）`,
        '错题：',
        ...wrongAnswers.map((a) => {
          const keyQ = answerKeyQuestions.find((q) => q.question_number === a.questionNumber);
          return `  #${a.questionNumber}  你的答案：${a.studentAnswer}    正确：${keyQ?.correct_answer || ''}`;
        }),
      ];
      return { 反馈: sanitizeCell(lines.join('\n')) };
    });

    // Write XLSX (pattern from grades-agent: saveBuffer empty → writeFile → readFile)
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(overviewRows.length ? overviewRows : [{}]), '成绩总览');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(matrixRows.length ? matrixRows : [{}]), '逐题矩阵');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(questionStats.length ? questionStats : [{}]), '错题统计');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(feedbackRows.length ? feedbackRows : [{}]), '逐人反馈卡');

    const xlsxSaved = await this.storage.saveBuffer({
      userId,
      category: 'outputs',
      originalName: `quiz-${jobId}.xlsx`,
      buffer: Buffer.alloc(0),
    });
    XLSX.writeFile(wb, xlsxSaved.path);
    const xlsxBuf = await this.storage.readFile(xlsxSaved.path);
    const xlsxFileId = this.db.createFile({
      userId,
      kind: 'quiz_xlsx',
      filename: xlsxSaved.filename,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: xlsxBuf.length,
      filePath: xlsxSaved.path,
    });

    // Write CSV (overview sheet)
    const csvHeaders = ['姓名', '学号', '正确', '错误', '未识别', '得分率', '排名'];
    const csvLines = [csvHeaders.join(',')];
    for (const row of overviewRows) {
      csvLines.push(csvHeaders.map((h) => csvEscape(row[h])).join(','));
    }

    const csvSaved = await this.storage.writeText({
      userId,
      category: 'outputs',
      originalName: `quiz-${jobId}.csv`,
      text: csvLines.join('\n'),
    });
    const csvBuf = await this.storage.readFile(csvSaved.path);
    const csvFileId = this.db.createFile({
      userId,
      kind: 'quiz_csv',
      filename: csvSaved.filename,
      mime: 'text/csv',
      size: csvBuf.length,
      filePath: csvSaved.path,
    });

    // Build summary
    const allScoreRates = overviewRows.map((r) => parseFloat(r['得分率']));
    const avg = allScoreRates.length > 0
      ? (allScoreRates.reduce((a, b) => a + b, 0) / allScoreRates.length).toFixed(1)
      : '0.0';
    const maxVal = allScoreRates.length > 0 ? Math.max(...allScoreRates) : 0;
    const minVal = allScoreRates.length > 0 ? Math.min(...allScoreRates) : 0;
    const maxRow = overviewRows.find((r) => parseFloat(r['得分率']) === maxVal);
    const minRow = overviewRows.find((r) => parseFloat(r['得分率']) === minVal);

    const highErrorQuestions = questionStats
      .filter((q) => parseFloat(q['错误率']) >= 50)
      .slice(0, 5)
      .map((q) => ({ question_number: q.题号, error_rate: q['错误率'], correct_answer: q.正确答案 }));

    const summary = {
      student_count: allStudentResults.length,
      average: `${avg}%`,
      max_student: maxRow?.姓名 || '',
      max_rate: maxRow?.['得分率'] || '',
      min_student: minRow?.姓名 || '',
      min_rate: minRow?.['得分率'] || '',
      high_error_questions: highErrorQuestions,
    };

    return { csvFileId, xlsxFileId, summary };
  }
}
