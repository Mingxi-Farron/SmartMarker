import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DB } from '../db.js';
import { MainAgent } from '../agents/main-agent.js';
import { ModelClient } from '../agents/model-client.js';

let db, mainAgent, tmpDir;

function createTestUser() {
  db.ensureInvite({ code: 'test-code' });
  return db.redeemInvite('test-code').user_id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartmarker-test-'));
  db = new DB(tmpDir);
  const modelClient = new ModelClient({
    endpoint: 'http://test',
    apiKey: 'test-key',
    model: 'test-model',
    mockMode: true
  });
  mainAgent = new MainAgent({ db, modelClient, hub: { onlineDeviceIds: () => new Map() }, weatherService: {} });
});

afterEach(() => {
  if (db?.db) db.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── inferIntent tests ───

describe('inferIntent: quiz_grade', () => {
  it('returns quiz_grade for "过关单"', () => {
    expect(mainAgent.inferIntent('帮我批改过关单')).toBe('quiz_grade');
  });

  it('returns quiz_grade for "上传答案"', () => {
    expect(mainAgent.inferIntent('上传标准答案')).toBe('quiz_grade');
  });

  it('returns quiz_grade for "答题卡"', () => {
    expect(mainAgent.inferIntent('批改答题卡')).toBe('quiz_grade');
  });

  it('returns quiz_grade for "批改试卷"', () => {
    expect(mainAgent.inferIntent('帮我批改试卷')).toBe('quiz_grade');
  });

  it('returns quiz_grade for "答案录入"', () => {
    expect(mainAgent.inferIntent('答案录入')).toBe('quiz_grade');
  });

  it('does NOT return quiz_grade for grades keywords', () => {
    expect(mainAgent.inferIntent('查看成绩')).toBe('grades');
    expect(mainAgent.inferIntent('分数统计')).toBe('grades');
    expect(mainAgent.inferIntent('上传csv')).toBe('grades');
  });

  it('quiz_grade takes priority over grades when both could match', () => {
    // "过关单" is quiz, even if "成绩" is in the same sentence
    expect(mainAgent.inferIntent('过关单成绩')).toBe('quiz_grade');
  });
});

// ─── handleQuizGradeIntent tests ───

describe('handleQuizGradeIntent', () => {
  let userId, sessionId;

  beforeEach(() => {
    userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    sessionId = session.id;
  });

  it('returns guidance when no upload and no answer_key_id', async () => {
    const result = await mainAgent.handleQuizGradeIntent({
      userId,
      message: '批改过关单',
      context: {},
      history: [],
      sessionId
    });
    expect(result.intent).toBe('quiz_grade');
    expect(result.reply).toContain('两步');
    expect(result.action).toBe('quiz_grade_guidance');
  });

  it('creates quiz_key job when upload present but no answer_key_id', async () => {
    // Create a mock upload
    const fileId = db.createFile({
      userId, kind: 'image', filename: 'answer.jpg',
      mime: 'image/jpeg', size: 100,
      filePath: path.join(tmpDir, 'fake.jpg')
    });
    const uploadId = db.createUpload({ userId, fileIds: [fileId] });

    const result = await mainAgent.handleQuizGradeIntent({
      userId,
      message: '上传答案',
      context: { upload_id: uploadId },
      history: [],
      sessionId
    });
    expect(result.intent).toBe('quiz_grade');
    expect(result.action).toBe('job_created');
    expect(result.job_id).toBeDefined();

    // Verify job was created with correct type
    const job = db.getJobForUser({ userId, jobId: result.job_id });
    expect(job.type).toBe('quiz_key');
  });

  it('creates quiz_grade job when upload + answer_key_id present', async () => {
    const answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    const fileId = db.createFile({
      userId, kind: 'image', filename: 's.jpg',
      mime: 'image/jpeg', size: 100,
      filePath: path.join(tmpDir, 'fake.jpg')
    });
    const uploadId = db.createUpload({ userId, fileIds: [fileId] });

    const result = await mainAgent.handleQuizGradeIntent({
      userId,
      message: '开始批改',
      context: { upload_id: uploadId, answer_key_id: answerKeyId },
      history: [],
      sessionId
    });
    expect(result.action).toBe('job_created');
    const job = db.getJobForUser({ userId, jobId: result.job_id });
    expect(job.type).toBe('quiz_grade');
    expect(job.input.answer_key_id).toBe(answerKeyId);
  });

  it('creates quiz_grade job with append_to_result_id when quiz_result_id present', async () => {
    const answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    const resultId = db.createQuizResult({ userId, answerKeyId });
    const fileId = db.createFile({
      userId, kind: 'image', filename: 's.jpg',
      mime: 'image/jpeg', size: 100,
      filePath: path.join(tmpDir, 'fake.jpg')
    });
    const uploadId = db.createUpload({ userId, fileIds: [fileId] });

    const result = await mainAgent.handleQuizGradeIntent({
      userId,
      message: '追加批改',
      context: { upload_id: uploadId, answer_key_id: answerKeyId, quiz_result_id: resultId },
      history: [],
      sessionId
    });
    expect(result.action).toBe('job_created');
    const job = db.getJobForUser({ userId, jobId: result.job_id });
    expect(job.input.append_to_result_id).toBe(resultId);
  });

  it('returns query mode when no upload but quiz_result_id present', async () => {
    const answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    const resultId = db.createQuizResult({ userId, answerKeyId });

    const result = await mainAgent.handleQuizGradeIntent({
      userId,
      message: '查看结果',
      context: { quiz_result_id: resultId },
      history: [],
      sessionId
    });
    expect(result.intent).toBe('quiz_grade');
    expect(result.action).toBe('quiz_query');
  });

  it('handles answer confirmation ("没问题" after "答案已识别")', async () => {
    const answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });

    const result = await mainAgent.handleQuizGradeIntent({
      userId,
      message: '没问题',
      context: { answer_key_id: answerKeyId },
      history: [
        { role: 'assistant', content: '✅ 答案已识别，共 20 题' }
      ],
      sessionId
    });
    expect(result.intent).toBe('quiz_grade');
    expect(result.action).toBe('answer_key_confirmed');
  });

  it('handles answer correction ("47:movable" after "答案已识别")', async () => {
    const answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    db.bulkInsertAnswerKeyQuestions({
      answerKeyId,
      questions: [{ questionNumber: 47, correctAnswer: 'mobile', knowledgeTag: '', confidence: 0.5 }]
    });

    const result = await mainAgent.handleQuizGradeIntent({
      userId,
      message: '47:movable',
      context: { answer_key_id: answerKeyId },
      history: [
        { role: 'assistant', content: '✅ 答案已识别，共 20 题' }
      ],
      sessionId
    });
    expect(result.intent).toBe('quiz_grade');
    expect(result.action).toBe('answer_key_corrected');

    // Verify the correction was saved
    const questions = db.listQuestionsForAnswerKey({ answerKeyId });
    const q47 = questions.find(q => q.question_number === 47);
    expect(q47.correct_answer).toBe('movable');
  });

  it('handles review verdict ("1 3" after "需要你确认")', async () => {
    const answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    const resultId = db.createQuizResult({ userId, answerKeyId });
    db.bulkInsertQuizResultAnswers({
      resultId,
      answers: [
        { studentName: '张三', studentIdNumber: '001', questionNumber: 47, studentAnswer: 'achive', isCorrect: 0, confidence: 0.3 },
        { studentName: '李四', studentIdNumber: '002', questionNumber: 63, studentAnswer: 'seperate', isCorrect: 0, confidence: 0.3 },
        { studentName: '王五', studentIdNumber: '003', questionNumber: 91, studentAnswer: 'goverment', isCorrect: 0, confidence: 0.3 }
      ]
    });
    const lowConf = db.getLowConfidenceAnswers({ resultId, maxConfidence: 0.5 });

    const result = await mainAgent.handleQuizGradeIntent({
      userId,
      message: '1 3',
      context: { quiz_result_id: resultId },
      history: [
        {
          role: 'assistant',
          content: `⚠️ 以下答案 OCR 不太确定，请确认：\n1. 张三 #47\n2. 李四 #63\n3. 王五 #91\n需要你确认`
        }
      ],
      sessionId
    });
    expect(result.intent).toBe('quiz_grade');
    expect(result.action).toBe('review_verdict_applied');
  });
});

// ─── handleChat dispatch ───

describe('handleChat quiz_grade dispatch', () => {
  let userId, sessionId;

  beforeEach(() => {
    userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    sessionId = session.id;
  });

  it('dispatches quiz_grade intent from chat message', async () => {
    const result = await mainAgent.handleChat({
      userId,
      sessionId,
      message: '帮我批改过关单',
      context: {}
    });
    expect(result.intent).toBe('quiz_grade');
    expect(result.session_id).toBe(sessionId);
  });
});

// ─── REST endpoint logic tests (DB-level, not HTTP) ───

describe('Phase 4: REST endpoint logic', () => {
  let userId;

  beforeEach(() => {
    userId = createTestUser();
  });

  it('listAnswerKeysForUser returns empty array for new user', () => {
    const keys = db.listAnswerKeysForUser({ userId });
    expect(keys).toEqual([]);
  });

  it('getAnswerKeyWithQuestions returns key + questions', () => {
    const id = db.createAnswerKey({ userId, title: 'test', pageCount: 2 });
    db.bulkInsertAnswerKeyQuestions({
      answerKeyId: id,
      questions: [
        { questionNumber: 1, correctAnswer: 'a', knowledgeTag: '', confidence: 1.0 },
        { questionNumber: 2, correctAnswer: 'b', knowledgeTag: '', confidence: 1.0 }
      ]
    });
    const result = db.getAnswerKeyWithQuestions({ userId, answerKeyId: id });
    expect(result.answerKey.id).toBe(id);
    expect(result.questions).toHaveLength(2);
  });

  it('createJob with quiz_key type works', () => {
    const jobId = db.createJob({ userId, type: 'quiz_key', input: { upload_id: 'test' } });
    const job = db.getJobForUser({ userId, jobId });
    expect(job.type).toBe('quiz_key');
    expect(job.status).toBe('queued');
  });

  it('createJob with quiz_grade type works', () => {
    const answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    const jobId = db.createJob({
      userId,
      type: 'quiz_grade',
      input: { upload_id: 'test', answer_key_id: answerKeyId }
    });
    const job = db.getJobForUser({ userId, jobId });
    expect(job.type).toBe('quiz_grade');
  });
});
