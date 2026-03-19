import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB } from '../db.js';

let db;
let tmpDir;

function createTestUser() {
  db.ensureInvite({ code: 'test-code' });
  const result = db.redeemInvite('test-code');
  return result.user_id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartmarker-test-'));
  db = new DB(tmpDir);
});

afterEach(() => {
  if (db?.db) {
    db.db.close();
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Table existence tests ───

describe('Phase 1: Quiz tables exist', () => {
  it('should create answer_keys table', () => {
    const columns = db.db.prepare('PRAGMA table_info(answer_keys)').all();
    const names = columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('user_id');
    expect(names).toContain('title');
    expect(names).toContain('page_count');
    expect(names).toContain('source_job_id');
    expect(names).toContain('created_at');
    expect(names).toContain('updated_at');
  });

  it('should create answer_key_questions table', () => {
    const columns = db.db.prepare('PRAGMA table_info(answer_key_questions)').all();
    const names = columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('answer_key_id');
    expect(names).toContain('question_number');
    expect(names).toContain('correct_answer');
    expect(names).toContain('knowledge_tag');
    expect(names).toContain('confidence');
    expect(names).toContain('created_at');
  });

  it('should create quiz_results table', () => {
    const columns = db.db.prepare('PRAGMA table_info(quiz_results)').all();
    const names = columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('user_id');
    expect(names).toContain('answer_key_id');
    expect(names).toContain('source_job_id');
    expect(names).toContain('student_count');
    expect(names).toContain('created_at');
    expect(names).toContain('updated_at');
  });

  it('should create quiz_result_answers table', () => {
    const columns = db.db.prepare('PRAGMA table_info(quiz_result_answers)').all();
    const names = columns.map((c) => c.name);
    expect(names).toContain('id');
    expect(names).toContain('result_id');
    expect(names).toContain('student_name');
    expect(names).toContain('student_id_number');
    expect(names).toContain('question_number');
    expect(names).toContain('student_answer');
    expect(names).toContain('is_correct');
    expect(names).toContain('confidence');
    expect(names).toContain('created_at');
  });

  it('should be idempotent - creating DB twice does not error', () => {
    const db2 = new DB(tmpDir);
    const columns = db2.db.prepare('PRAGMA table_info(answer_keys)').all();
    expect(columns.length).toBeGreaterThan(0);
    db2.db.close();
  });
});

// ─── answer_keys CRUD ───

describe('Phase 1: answer_keys CRUD', () => {
  let userId;

  beforeEach(() => {
    userId = createTestUser();
  });

  it('createAnswerKey returns an id string', () => {
    const id = db.createAnswerKey({ userId, title: '第一单元过关单', pageCount: 3, sourceJobId: null });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('getAnswerKeyForUser returns the created key', () => {
    const id = db.createAnswerKey({ userId, title: '测试', pageCount: 2, sourceJobId: 'job-1' });
    const key = db.getAnswerKeyForUser({ userId, answerKeyId: id });
    expect(key).not.toBeNull();
    expect(key.id).toBe(id);
    expect(key.user_id).toBe(userId);
    expect(key.title).toBe('测试');
    expect(key.page_count).toBe(2);
    expect(key.source_job_id).toBe('job-1');
  });

  it('getAnswerKeyForUser returns null for wrong user', () => {
    const id = db.createAnswerKey({ userId, title: '测试', pageCount: 1 });
    const key = db.getAnswerKeyForUser({ userId: 'wrong-user', answerKeyId: id });
    expect(key).toBeNull();
  });

  it('listAnswerKeysForUser returns keys ordered by created_at DESC', () => {
    db.createAnswerKey({ userId, title: 'first', pageCount: 1 });
    db.createAnswerKey({ userId, title: 'second', pageCount: 2 });
    const keys = db.listAnswerKeysForUser({ userId });
    expect(keys.length).toBe(2);
    expect(keys[0].title).toBe('second');
    expect(keys[1].title).toBe('first');
  });

  it('listAnswerKeysForUser respects limit', () => {
    db.createAnswerKey({ userId, title: 'a', pageCount: 1 });
    db.createAnswerKey({ userId, title: 'b', pageCount: 1 });
    db.createAnswerKey({ userId, title: 'c', pageCount: 1 });
    const keys = db.listAnswerKeysForUser({ userId, limit: 2 });
    expect(keys.length).toBe(2);
  });

  it('updateAnswerKey updates title and pageCount', () => {
    const id = db.createAnswerKey({ userId, title: 'old', pageCount: 1 });
    db.updateAnswerKey({ userId, answerKeyId: id, title: 'new', pageCount: 5 });
    const key = db.getAnswerKeyForUser({ userId, answerKeyId: id });
    expect(key.title).toBe('new');
    expect(key.page_count).toBe(5);
  });

  it('updateAnswerKey partial update - only title', () => {
    const id = db.createAnswerKey({ userId, title: 'old', pageCount: 3 });
    db.updateAnswerKey({ userId, answerKeyId: id, title: 'new' });
    const key = db.getAnswerKeyForUser({ userId, answerKeyId: id });
    expect(key.title).toBe('new');
    expect(key.page_count).toBe(3);
  });

  it('updateAnswerKey returns null for wrong user', () => {
    const id = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    const result = db.updateAnswerKey({ userId: 'wrong-user', answerKeyId: id, title: 'hacked' });
    expect(result).toBeNull();
    const key = db.getAnswerKeyForUser({ userId, answerKeyId: id });
    expect(key.title).toBe('test');
  });

  it('deleteAnswerKeyForUser removes the key', () => {
    const id = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    const deleted = db.deleteAnswerKeyForUser({ userId, answerKeyId: id });
    expect(deleted).toEqual({ deleted: true });
    const key = db.getAnswerKeyForUser({ userId, answerKeyId: id });
    expect(key).toBeNull();
  });

  it('deleteAnswerKeyForUser returns null for wrong user', () => {
    const id = db.createAnswerKey({ userId, title: 'test', pageCount: 1 });
    const deleted = db.deleteAnswerKeyForUser({ userId: 'wrong-user', answerKeyId: id });
    expect(deleted).toBeNull();
  });
});

// ─── answer_key_questions CRUD ───

describe('Phase 1: answer_key_questions CRUD', () => {
  let userId;
  let answerKeyId;

  beforeEach(() => {
    userId = createTestUser();
    answerKeyId = db.createAnswerKey({ userId, title: '测试', pageCount: 2 });
  });

  it('bulkInsertAnswerKeyQuestions inserts all questions', () => {
    const questions = [
      { questionNumber: 1, correctAnswer: 'deep', knowledgeTag: 'vocabulary', confidence: 0.95 },
      { questionNumber: 2, correctAnswer: 'desert', knowledgeTag: 'vocabulary', confidence: 1.0 },
      { questionNumber: 3, correctAnswer: 'Asia', knowledgeTag: 'geography', confidence: 0.8 }
    ];
    db.bulkInsertAnswerKeyQuestions({ answerKeyId, questions });
    const result = db.listQuestionsForAnswerKey({ answerKeyId });
    expect(result.length).toBe(3);
    expect(result[0].question_number).toBe(1);
    expect(result[0].correct_answer).toBe('deep');
    expect(result[0].knowledge_tag).toBe('vocabulary');
    expect(result[0].confidence).toBe(0.95);
  });

  it('listQuestionsForAnswerKey returns ordered by question_number', () => {
    const questions = [
      { questionNumber: 3, correctAnswer: 'c', knowledgeTag: '', confidence: 1.0 },
      { questionNumber: 1, correctAnswer: 'a', knowledgeTag: '', confidence: 1.0 },
      { questionNumber: 2, correctAnswer: 'b', knowledgeTag: '', confidence: 1.0 }
    ];
    db.bulkInsertAnswerKeyQuestions({ answerKeyId, questions });
    const result = db.listQuestionsForAnswerKey({ answerKeyId });
    expect(result.map((q) => q.question_number)).toEqual([1, 2, 3]);
  });

  it('updateAnswerKeyQuestion updates a single question', () => {
    db.bulkInsertAnswerKeyQuestions({
      answerKeyId,
      questions: [{ questionNumber: 47, correctAnswer: 'mobile', knowledgeTag: 'adj', confidence: 0.5 }]
    });
    const [q] = db.listQuestionsForAnswerKey({ answerKeyId });
    db.updateAnswerKeyQuestion({ userId, questionId: q.id, correctAnswer: 'movable', confidence: 1.0 });
    const [updated] = db.listQuestionsForAnswerKey({ answerKeyId });
    expect(updated.correct_answer).toBe('movable');
    expect(updated.confidence).toBe(1.0);
  });

  it('updateAnswerKeyQuestion returns null for wrong user', () => {
    db.bulkInsertAnswerKeyQuestions({
      answerKeyId,
      questions: [{ questionNumber: 1, correctAnswer: 'original', knowledgeTag: '', confidence: 1.0 }]
    });
    const [q] = db.listQuestionsForAnswerKey({ answerKeyId });
    const result = db.updateAnswerKeyQuestion({ userId: 'wrong', questionId: q.id, correctAnswer: 'hacked' });
    expect(result).toBeNull();
    const [unchanged] = db.listQuestionsForAnswerKey({ answerKeyId });
    expect(unchanged.correct_answer).toBe('original');
  });

  it('getAnswerKeyWithQuestions returns combined data', () => {
    db.bulkInsertAnswerKeyQuestions({
      answerKeyId,
      questions: [
        { questionNumber: 1, correctAnswer: 'a', knowledgeTag: '', confidence: 1.0 },
        { questionNumber: 2, correctAnswer: 'b', knowledgeTag: '', confidence: 0.9 }
      ]
    });
    const result = db.getAnswerKeyWithQuestions({ userId, answerKeyId });
    expect(result).not.toBeNull();
    expect(result.answerKey.id).toBe(answerKeyId);
    expect(result.questions.length).toBe(2);
  });

  it('getAnswerKeyWithQuestions returns null for wrong user', () => {
    const result = db.getAnswerKeyWithQuestions({ userId: 'wrong', answerKeyId });
    expect(result).toBeNull();
  });

  it('CASCADE delete removes questions when answer key is deleted', () => {
    db.bulkInsertAnswerKeyQuestions({
      answerKeyId,
      questions: [{ questionNumber: 1, correctAnswer: 'a', knowledgeTag: '', confidence: 1.0 }]
    });
    db.deleteAnswerKeyForUser({ userId, answerKeyId });
    const questions = db.listQuestionsForAnswerKey({ answerKeyId });
    expect(questions.length).toBe(0);
  });
});

// ─── quiz_results CRUD ───

describe('Phase 1: quiz_results CRUD', () => {
  let userId;
  let answerKeyId;

  beforeEach(() => {
    userId = createTestUser();
    answerKeyId = db.createAnswerKey({ userId, title: '测试', pageCount: 1 });
  });

  it('createQuizResult returns an id string', () => {
    const id = db.createQuizResult({ userId, answerKeyId, sourceJobId: 'job-1' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('getQuizResultForUser returns the created result', () => {
    const id = db.createQuizResult({ userId, answerKeyId, sourceJobId: 'job-1' });
    const result = db.getQuizResultForUser({ userId, resultId: id });
    expect(result).not.toBeNull();
    expect(result.id).toBe(id);
    expect(result.user_id).toBe(userId);
    expect(result.answer_key_id).toBe(answerKeyId);
    expect(result.student_count).toBe(0);
  });

  it('getQuizResultForUser returns null for wrong user', () => {
    const id = db.createQuizResult({ userId, answerKeyId });
    expect(db.getQuizResultForUser({ userId: 'wrong', resultId: id })).toBeNull();
  });

  it('updateQuizResult updates student count', () => {
    const id = db.createQuizResult({ userId, answerKeyId });
    db.updateQuizResult({ userId, resultId: id, studentCount: 28 });
    const result = db.getQuizResultForUser({ userId, resultId: id });
    expect(result.student_count).toBe(28);
  });

  it('updateQuizResult returns null for wrong user', () => {
    const id = db.createQuizResult({ userId, answerKeyId });
    const result = db.updateQuizResult({ userId: 'wrong', resultId: id, studentCount: 999 });
    expect(result).toBeNull();
    const unchanged = db.getQuizResultForUser({ userId, resultId: id });
    expect(unchanged.student_count).toBe(0);
  });

  it('listQuizResultsForUser returns results ordered DESC', () => {
    db.createQuizResult({ userId, answerKeyId });
    db.createQuizResult({ userId, answerKeyId });
    const results = db.listQuizResultsForUser({ userId });
    expect(results.length).toBe(2);
    expect(results[0].created_at >= results[1].created_at).toBe(true);
  });

  it('deleteQuizResultForUser removes the result', () => {
    const id = db.createQuizResult({ userId, answerKeyId });
    const deleted = db.deleteQuizResultForUser({ userId, resultId: id });
    expect(deleted).toEqual({ deleted: true });
    expect(db.getQuizResultForUser({ userId, resultId: id })).toBeNull();
  });
});

// ─── quiz_result_answers CRUD ───

describe('Phase 1: quiz_result_answers CRUD', () => {
  let userId;
  let answerKeyId;
  let resultId;

  beforeEach(() => {
    userId = createTestUser();
    answerKeyId = db.createAnswerKey({ userId, title: '测试', pageCount: 1 });
    resultId = db.createQuizResult({ userId, answerKeyId });
  });

  it('bulkInsertQuizResultAnswers inserts all answers', () => {
    const answers = [
      { studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'deep', isCorrect: 1, confidence: 1.0 },
      { studentName: '张三', studentIdNumber: '001', questionNumber: 2, studentAnswer: 'desart', isCorrect: 0, confidence: 0.9 },
      { studentName: '李四', studentIdNumber: '002', questionNumber: 1, studentAnswer: 'deep', isCorrect: 1, confidence: 1.0 },
      { studentName: '李四', studentIdNumber: '002', questionNumber: 2, studentAnswer: 'desert', isCorrect: 1, confidence: 1.0 }
    ];
    db.bulkInsertQuizResultAnswers({ resultId, answers });
    const all = db.listAnswersForQuizResult({ resultId });
    expect(all.length).toBe(4);
  });

  it('bulkInsertQuizResultAnswers updates parent student_count', () => {
    const answers = [
      { studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'a', isCorrect: 1, confidence: 1.0 },
      { studentName: '李四', studentIdNumber: '002', questionNumber: 1, studentAnswer: 'b', isCorrect: 0, confidence: 1.0 }
    ];
    db.bulkInsertQuizResultAnswers({ resultId, answers });
    const result = db.getQuizResultForUser({ userId, resultId });
    expect(result.student_count).toBe(2);
  });

  it('listAnswersForStudent returns only that student', () => {
    const answers = [
      { studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'a', isCorrect: 1, confidence: 1.0 },
      { studentName: '李四', studentIdNumber: '002', questionNumber: 1, studentAnswer: 'b', isCorrect: 0, confidence: 1.0 }
    ];
    db.bulkInsertQuizResultAnswers({ resultId, answers });
    const studentAnswers = db.listAnswersForStudent({ resultId, studentName: '张三' });
    expect(studentAnswers.length).toBe(1);
    expect(studentAnswers[0].student_name).toBe('张三');
  });

  it('updateQuizResultAnswer updates correctness', () => {
    db.bulkInsertQuizResultAnswers({
      resultId,
      answers: [{ studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'achieve', isCorrect: 0, confidence: 0.5 }]
    });
    const [answer] = db.listAnswersForQuizResult({ resultId });
    db.updateQuizResultAnswer({ userId, answerId: answer.id, isCorrect: 1, confidence: 1.0 });
    const [updated] = db.listAnswersForQuizResult({ resultId });
    expect(updated.is_correct).toBe(1);
    expect(updated.confidence).toBe(1.0);
  });

  it('updateQuizResultAnswer returns null for wrong user', () => {
    db.bulkInsertQuizResultAnswers({
      resultId,
      answers: [{ studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'a', isCorrect: 0, confidence: 0.5 }]
    });
    const [answer] = db.listAnswersForQuizResult({ resultId });
    const result = db.updateQuizResultAnswer({ userId: 'wrong', answerId: answer.id, isCorrect: 1 });
    expect(result).toBeNull();
    const [unchanged] = db.listAnswersForQuizResult({ resultId });
    expect(unchanged.is_correct).toBe(0);
  });

  it('getQuizResultSummary returns correct aggregates', () => {
    const answers = [
      { studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'a', isCorrect: 1, confidence: 1.0 },
      { studentName: '张三', studentIdNumber: '001', questionNumber: 2, studentAnswer: 'b', isCorrect: 0, confidence: 1.0 },
      { studentName: '李四', studentIdNumber: '002', questionNumber: 1, studentAnswer: 'a', isCorrect: 1, confidence: 1.0 },
      { studentName: '李四', studentIdNumber: '002', questionNumber: 2, studentAnswer: 'c', isCorrect: 1, confidence: 1.0 }
    ];
    db.bulkInsertQuizResultAnswers({ resultId, answers });
    const summary = db.getQuizResultSummary({ resultId });
    expect(summary.student_count).toBe(2);
    expect(summary.question_count).toBe(2);
    expect(summary.average_correct_rate).toBe(75.0);
  });

  it('getHighErrorQuestions returns questions above error threshold', () => {
    const answers = [
      { studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'a', isCorrect: 1, confidence: 1.0 },
      { studentName: '李四', studentIdNumber: '002', questionNumber: 1, studentAnswer: 'wrong', isCorrect: 0, confidence: 1.0 },
      { studentName: '王五', studentIdNumber: '003', questionNumber: 1, studentAnswer: 'wrong', isCorrect: 0, confidence: 1.0 },
      // Q2: all correct - should NOT appear
      { studentName: '张三', studentIdNumber: '001', questionNumber: 2, studentAnswer: 'b', isCorrect: 1, confidence: 1.0 },
      { studentName: '李四', studentIdNumber: '002', questionNumber: 2, studentAnswer: 'b', isCorrect: 1, confidence: 1.0 },
      { studentName: '王五', studentIdNumber: '003', questionNumber: 2, studentAnswer: 'b', isCorrect: 1, confidence: 1.0 }
    ];
    db.bulkInsertQuizResultAnswers({ resultId, answers });
    // Q1 error rate = 66.7%, Q2 = 0%
    const highError = db.getHighErrorQuestions({ resultId, minErrorRate: 0.5 });
    expect(highError.length).toBe(1);
    expect(highError[0].question_number).toBe(1);
    expect(highError[0].error_rate).toBeGreaterThan(60);
  });

  it('getLowConfidenceAnswers returns answers below threshold', () => {
    const answers = [
      { studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'achive', isCorrect: 0, confidence: 0.3 },
      { studentName: '张三', studentIdNumber: '001', questionNumber: 2, studentAnswer: 'desert', isCorrect: 1, confidence: 1.0 },
      { studentName: '李四', studentIdNumber: '002', questionNumber: 1, studentAnswer: 'achieve', isCorrect: 1, confidence: 0.4 }
    ];
    db.bulkInsertQuizResultAnswers({ resultId, answers });
    const lowConf = db.getLowConfidenceAnswers({ resultId, maxConfidence: 0.5 });
    expect(lowConf.length).toBe(2);
    expect(lowConf[0].confidence).toBeLessThanOrEqual(0.5);
  });

  it('CASCADE delete removes answers when quiz result is deleted', () => {
    db.bulkInsertQuizResultAnswers({
      resultId,
      answers: [{ studentName: '张三', studentIdNumber: '001', questionNumber: 1, studentAnswer: 'a', isCorrect: 1, confidence: 1.0 }]
    });
    db.deleteQuizResultForUser({ userId, resultId });
    const answers = db.listAnswersForQuizResult({ resultId });
    expect(answers.length).toBe(0);
  });
});
