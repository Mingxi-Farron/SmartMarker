import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartmarker-ux-'));
  db = new DB(tmpDir);
  const modelClient = new ModelClient({
    endpoint: 'http://test', apiKey: 'k', model: 'm', mockMode: true
  });
  mainAgent = new MainAgent({ db, modelClient, hub: { onlineDeviceIds: () => new Map() }, weatherService: {} });
});

afterEach(() => {
  if (db?.db) db.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Item 1 (P0): "查看确认题" returns low-confidence list ───

describe('UX Item 1: 查看确认题', () => {
  let userId, sessionId, answerKeyId, resultId;

  beforeEach(() => {
    userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    sessionId = session.id;
    answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    db.bulkInsertAnswerKeyQuestions({
      answerKeyId,
      questions: [
        { questionNumber: 47, correctAnswer: 'achieve', knowledgeTag: '', confidence: 1.0 },
        { questionNumber: 63, correctAnswer: 'separate', knowledgeTag: '', confidence: 1.0 }
      ]
    });
    resultId = db.createQuizResult({ userId, answerKeyId });
    db.bulkInsertQuizResultAnswers({
      resultId,
      answers: [
        { studentName: '张三', studentIdNumber: '001', questionNumber: 47, studentAnswer: 'achive', isCorrect: 0, confidence: 0.3 },
        { studentName: '李四', studentIdNumber: '002', questionNumber: 63, studentAnswer: 'seperate', isCorrect: 0, confidence: 0.4 }
      ]
    });
  });

  it('returns formatted low-confidence list when user says "查看确认题"', async () => {
    const result = await mainAgent.handleQuizGradeIntent({
      userId, message: '查看确认题',
      context: { quiz_result_id: resultId },
      history: [], sessionId
    });
    expect(result.action).toBe('quiz_low_confidence_review');
    expect(result.reply).toContain('张三');
    expect(result.reply).toContain('#47');
  });

  it('returns "没有需要确认的题目" when no low-confidence items', async () => {
    // Update all answers to high confidence
    const answers = db.listAnswersForQuizResult({ resultId });
    for (const a of answers) {
      db.updateQuizResultAnswer({ userId, answerId: a.id, isCorrect: 1, confidence: 1.0 });
    }
    const result = await mainAgent.handleQuizGradeIntent({
      userId, message: '查看确认题',
      context: { quiz_result_id: resultId },
      history: [], sessionId
    });
    expect(result.reply).toContain('没有需要确认');
  });
});

// ─── Item 5 (P1): Correction shows old→new detail ───

describe('UX Item 5: correction reply detail', () => {
  it('shows old→new values after correction', async () => {
    const userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    const answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    db.bulkInsertAnswerKeyQuestions({
      answerKeyId,
      questions: [{ questionNumber: 47, correctAnswer: 'mobile', knowledgeTag: '', confidence: 0.5 }]
    });
    const result = await mainAgent.handleQuizGradeIntent({
      userId, message: '47:movable',
      context: { answer_key_id: answerKeyId },
      history: [{ role: 'assistant', content: '✅ 答案已识别，共 20 题' }],
      sessionId: session.id
    });
    expect(result.reply).toContain('mobile');
    expect(result.reply).toContain('movable');
    expect(result.reply).toContain('→');
  });
});

// ─── Item 6 (P1): Guidance includes photo tips ───

describe('UX Item 6: enhanced guidance', () => {
  it('guidance includes photo tips and time estimate', async () => {
    const userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    const result = await mainAgent.handleQuizGradeIntent({
      userId, message: '批改过关单',
      context: {}, history: [], sessionId: session.id
    });
    expect(result.reply).toContain('拍照建议');
    expect(result.reply).toContain('预估时间');
    expect(result.reply).toContain('按顺序');
  });
});

// ─── Item 7 (P1): Append mode shows student count ───

describe('UX Item 7: append mode student count', () => {
  it('shows existing student count in append mode reply', async () => {
    const userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    const answerKeyId = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    const resultId = db.createQuizResult({ userId, answerKeyId });
    db.bulkInsertQuizResultAnswers({
      resultId,
      answers: [
        { studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'a', isCorrect: 1, confidence: 1.0 },
        { studentName: '李四', studentIdNumber: '002', questionNumber: 1, studentAnswer: 'b', isCorrect: 0, confidence: 1.0 }
      ]
    });
    const fileId = db.createFile({ userId, kind: 'image', filename: 's.jpg', mime: 'image/jpeg', size: 100, filePath: path.join(tmpDir, 'f.jpg') });
    const uploadId = db.createUpload({ userId, fileIds: [fileId] });

    const result = await mainAgent.handleQuizGradeIntent({
      userId, message: '追加批改',
      context: { upload_id: uploadId, answer_key_id: answerKeyId, quiz_result_id: resultId },
      history: [], sessionId: session.id
    });
    expect(result.reply).toContain('已有 2 人');
  });
});

// ─── Item 10 (P2): Answer key history ───

describe('UX Item 10: answer key history', () => {
  it('"之前的答案" lists saved answer keys', async () => {
    const userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    db.createAnswerKey({ userId, title: '第一单元', pageCount: 3 });
    db.createAnswerKey({ userId, title: '第二单元', pageCount: 2 });

    const result = await mainAgent.handleQuizGradeIntent({
      userId, message: '使用之前的答案',
      context: {}, history: [], sessionId: session.id
    });
    expect(result.action).toBe('quiz_list_answer_keys');
    expect(result.reply).toContain('第一单元');
    expect(result.reply).toContain('第二单元');
  });

  it('numeric selection after listing selects answer key', async () => {
    const userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    const id1 = db.createAnswerKey({ userId, title: '第一单元', pageCount: 3 });

    const result = await mainAgent.handleQuizGradeIntent({
      userId, message: '1',
      context: {},
      history: [{ role: 'assistant', content: '请回复编号选择' }],
      sessionId: session.id
    });
    expect(result.action).toBe('answer_key_selected');
    expect(result.answer_key_id).toBe(id1);
  });

  it('"之前的答案" with no saved keys returns guidance', async () => {
    const userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    const result = await mainAgent.handleQuizGradeIntent({
      userId, message: '使用之前的答案',
      context: {}, history: [], sessionId: session.id
    });
    expect(result.reply).toContain('还没有');
  });

  it('guidance mentions existing keys when user has saved keys', async () => {
    const userId = createTestUser();
    const session = db.createChatSession({ userId, title: 'test' });
    db.createAnswerKey({ userId, title: '测试', pageCount: 1 });

    const result = await mainAgent.handleQuizGradeIntent({
      userId, message: '批改过关单',
      context: {}, history: [], sessionId: session.id
    });
    expect(result.reply).toContain('已有保存的答案');
  });
});
