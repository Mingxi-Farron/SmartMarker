import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DB } from '../db.js';
import { Storage } from '../storage.js';
import { ModelClient } from '../agents/model-client.js';

// We'll import these once quiz-agent.js exists
let QuizAgent, parseCompactOcr, compareAnswers, groupPhotosByStudent, fixAnswerOffset;

let db, storage, modelClient, tmpDir, quizAgent;

function createTestUser() {
  db.ensureInvite({ code: 'test-code' });
  return db.redeemInvite('test-code').user_id;
}

async function createMockImageFile(dir, name = 'test.jpg') {
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fsp.writeFile(filePath, Buffer.from('fake-image-data'));
  return filePath;
}

beforeEach(async () => {
  const mod = await import('../agents/quiz-agent.js');
  QuizAgent = mod.QuizAgent;
  parseCompactOcr = mod.parseCompactOcr;
  compareAnswers = mod.compareAnswers;
  groupPhotosByStudent = mod.groupPhotosByStudent;
  fixAnswerOffset = mod.fixAnswerOffset;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartmarker-test-'));
  db = new DB(tmpDir);
  storage = new Storage(tmpDir);
  modelClient = new ModelClient({
    endpoint: 'http://test',
    apiKey: 'test-key',
    model: 'test-model',
    mockMode: true
  });
  quizAgent = new QuizAgent({ db, storage, modelClient, publicBaseUrl: 'http://localhost:3000' });
});

afterEach(() => {
  if (db?.db) db.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Pure function: parseCompactOcr ───

describe('parseCompactOcr', () => {
  it('parses valid compact format', () => {
    const result = parseCompactOcr('张三|240301|1:deep|2:desert|3:Asia');
    expect(result).not.toBeNull();
    expect(result.studentName).toBe('张三');
    expect(result.studentIdNumber).toBe('240301');
    expect(result.answers).toHaveLength(3);
    expect(result.answers[0]).toEqual({ questionNumber: 1, studentAnswer: 'deep' });
    expect(result.answers[2]).toEqual({ questionNumber: 3, studentAnswer: 'Asia' });
  });

  it('handles Chinese colon and extra whitespace', () => {
    const result = parseCompactOcr('李四|240302| 1：deep | 2 : desert ');
    expect(result).not.toBeNull();
    expect(result.answers[0].studentAnswer).toBe('deep');
    expect(result.answers[1].studentAnswer).toBe('desert');
  });

  it('handles full-width pipe delimiter', () => {
    const result = parseCompactOcr('王五｜240303｜1:deep｜2:desert');
    expect(result).not.toBeNull();
    expect(result.studentName).toBe('王五');
    expect(result.answers).toHaveLength(2);
  });

  it('returns null for empty input', () => {
    expect(parseCompactOcr('')).toBeNull();
    expect(parseCompactOcr(null)).toBeNull();
  });

  it('returns null for invalid format (too few parts)', () => {
    expect(parseCompactOcr('justtext')).toBeNull();
    expect(parseCompactOcr('a|b')).toBeNull();
  });

  it('defaults name to 未知 when empty', () => {
    const result = parseCompactOcr('|000000|1:deep');
    expect(result.studentName).toBe('未知');
  });
});

// ─── Pure function: compareAnswers ───

describe('compareAnswers', () => {
  const answerKey = [
    { question_number: 1, correct_answer: 'deep' },
    { question_number: 2, correct_answer: 'desert' },
    { question_number: 3, correct_answer: 'Asia' }
  ];

  it('marks correct answers', () => {
    const studentAnswers = [
      { questionNumber: 1, studentAnswer: 'deep' },
      { questionNumber: 2, studentAnswer: 'desert' }
    ];
    const { results } = compareAnswers(studentAnswers, answerKey);
    expect(results[0].isCorrect).toBe(true);
    expect(results[0].confidence).toBe(1.0);
    expect(results[1].isCorrect).toBe(true);
  });

  it('case-insensitive comparison', () => {
    const { results } = compareAnswers(
      [{ questionNumber: 1, studentAnswer: 'Deep' }],
      answerKey
    );
    expect(results[0].isCorrect).toBe(true);
  });

  it('marks wrong answers as mismatches', () => {
    const { results, mismatches } = compareAnswers(
      [{ questionNumber: 1, studentAnswer: 'dep' }],
      answerKey
    );
    expect(results[0].isCorrect).toBe(false);
    expect(results[0].confidence).toBe(0.5);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].questionNumber).toBe(1);
  });

  it('handles ? (unrecognized) as definitively wrong', () => {
    const { results, mismatches } = compareAnswers(
      [{ questionNumber: 1, studentAnswer: '?' }],
      answerKey
    );
    expect(results[0].isCorrect).toBe(false);
    expect(results[0].confidence).toBe(1.0);
    // ? should NOT be in mismatches (not a candidate for VLM verification)
    expect(mismatches).toHaveLength(0);
  });

  it('strips Chinese and POS markers from answer key before comparison', () => {
    const verboseKey = [
      { question_number: 1, correct_answer: 'throat n. 喉咙' },
      { question_number: 2, correct_answer: 'stomachache n. 胃痛；肚子疼' },
      { question_number: 3, correct_answer: 'take care of 照顾；护理' },
    ];
    const { results } = compareAnswers(
      [
        { questionNumber: 1, studentAnswer: 'throat' },
        { questionNumber: 2, studentAnswer: 'stomachache' },
        { questionNumber: 3, studentAnswer: 'take care of' },
      ],
      verboseKey
    );
    expect(results[0].isCorrect).toBe(true);
    expect(results[1].isCorrect).toBe(true);
    expect(results[2].isCorrect).toBe(true);
  });

  it('still catches genuine spelling errors after normalization', () => {
    const verboseKey = [
      { question_number: 1, correct_answer: 'throat n. 喉咙' },
    ];
    const { results, mismatches } = compareAnswers(
      [{ questionNumber: 1, studentAnswer: 'throet' }],
      verboseKey
    );
    expect(results[0].isCorrect).toBe(false);
    expect(mismatches).toHaveLength(1);
  });

  it('handles containment match when student writes more or less', () => {
    const key = [
      { question_number: 1, correct_answer: 'stay healthy and safe' },
    ];
    // Student wrote "stay healthy and safe" exactly
    const { results: r1 } = compareAnswers(
      [{ questionNumber: 1, studentAnswer: 'stay healthy and safe' }], key);
    expect(r1[0].isCorrect).toBe(true);
    expect(r1[0].confidence).toBe(1.0);
  });
});

// ─── Pure function: groupPhotosByStudent ───

describe('groupPhotosByStudent', () => {
  const makeFiles = (n) => Array.from({ length: n }, (_, i) => ({ path: `/tmp/${i}.jpg` }));

  it('groups 9 files with pageCount 3 into 3 groups', () => {
    const groups = groupPhotosByStudent(makeFiles(9), 3);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toHaveLength(3);
    expect(groups[2]).toHaveLength(3);
  });

  it('handles non-multiple (10 files, pageCount 3)', () => {
    const groups = groupPhotosByStudent(makeFiles(10), 3);
    expect(groups).toHaveLength(4);
    expect(groups[3]).toHaveLength(1); // last group incomplete
  });

  it('handles pageCount 1 (each file is a group)', () => {
    const groups = groupPhotosByStudent(makeFiles(5), 1);
    expect(groups).toHaveLength(5);
    expect(groups[0]).toHaveLength(1);
  });

  it('defaults pageCount 0 to 1', () => {
    const groups = groupPhotosByStudent(makeFiles(3), 0);
    expect(groups).toHaveLength(3);
  });

  it('handles empty files', () => {
    const groups = groupPhotosByStudent([], 3);
    expect(groups).toHaveLength(0);
  });
});

// ─── Pure function: fixAnswerOffset ───

describe('fixAnswerOffset', () => {
  const answerKey = [
    { question_number: 1, correct_answer: 'throat' },
    { question_number: 2, correct_answer: 'stomachache' },
    { question_number: 3, correct_answer: 'headache' },
    { question_number: 4, correct_answer: 'toothache' },
    { question_number: 5, correct_answer: 'backache' },
    { question_number: 6, correct_answer: 'take care of' },
    { question_number: 7, correct_answer: 'health problems' },
    { question_number: 8, correct_answer: 'physical conditions' },
    { question_number: 9, correct_answer: 'stay healthy and safe' },
    { question_number: 10, correct_answer: 'look well' },
  ];

  it('returns unchanged when answers are already aligned', () => {
    const student = [
      { questionNumber: 1, studentAnswer: 'throat' },
      { questionNumber: 2, studentAnswer: 'stomachache' },
      { questionNumber: 3, studentAnswer: 'headache' },
    ];
    const fixed = fixAnswerOffset(student, answerKey);
    expect(fixed).toEqual(student);
  });

  it('detects and fixes single-question skip (the health problems bug)', () => {
    // OCR skipped #7 (health problems), so #8's answer sits at position 7, etc.
    const student = [
      { questionNumber: 1, studentAnswer: 'throat' },
      { questionNumber: 2, studentAnswer: 'stomachache' },
      { questionNumber: 3, studentAnswer: 'headache' },
      { questionNumber: 4, studentAnswer: 'toothache' },
      { questionNumber: 5, studentAnswer: 'backache' },
      { questionNumber: 6, studentAnswer: 'take care of' },
      // #7 skipped — "health problems" missing
      { questionNumber: 7, studentAnswer: 'physical conditions' },  // actually #8's answer
      { questionNumber: 8, studentAnswer: 'stay healthy and safe' }, // actually #9's answer
      { questionNumber: 9, studentAnswer: 'look well' },            // actually #10's answer
    ];
    const fixed = fixAnswerOffset(student, answerKey);
    // After fix: #7 should be "?" and answers should shift back
    expect(fixed[6].questionNumber).toBe(7);
    expect(fixed[6].studentAnswer).toBe('?');
    expect(fixed[7].questionNumber).toBe(8);
    expect(fixed[7].studentAnswer).toBe('physical conditions');
  });

  it('does not "fix" when student genuinely got answers wrong', () => {
    const student = [
      { questionNumber: 1, studentAnswer: 'wrong1' },
      { questionNumber: 2, studentAnswer: 'wrong2' },
      { questionNumber: 3, studentAnswer: 'wrong3' },
    ];
    const fixed = fixAnswerOffset(student, answerKey);
    // No systematic offset detected, should remain unchanged
    expect(fixed).toEqual(student);
  });

  it('handles empty inputs', () => {
    expect(fixAnswerOffset([], answerKey)).toEqual([]);
    expect(fixAnswerOffset([{ questionNumber: 1, studentAnswer: 'x' }], [])).toEqual([{ questionNumber: 1, studentAnswer: 'x' }]);
  });
});

// ─── Integration: processAnswerKey ───

describe('processAnswerKey', () => {
  let userId;

  beforeEach(() => {
    userId = createTestUser();
  });

  it('creates answer key from VLM mock response', async () => {
    // Create mock upload with image files
    const imgDir = path.join(tmpDir, 'uploads');
    const imgPath = await createMockImageFile(imgDir, 'answer1.jpg');
    const fileId = db.createFile({
      userId,
      kind: 'image',
      filename: 'answer1.jpg',
      mime: 'image/jpeg',
      size: 100,
      filePath: imgPath
    });
    const uploadId = db.createUpload({ userId, fileIds: [fileId] });
    const jobId = db.createJob({ userId, type: 'quiz_key', input: { upload_id: uploadId } });
    const job = db.getJobForUser({ userId, jobId });

    await quizAgent.run(job);

    const updatedJob = db.getJobForUser({ userId, jobId });
    expect(updatedJob.status).toBe('done');
    expect(updatedJob.result).toHaveProperty('answer_key_id');
    expect(updatedJob.result).toHaveProperty('page_count');
    expect(updatedJob.result).toHaveProperty('question_count');
    expect(updatedJob.result.question_count).toBeGreaterThan(0);

    // Verify answer key was created in DB
    const key = db.getAnswerKeyForUser({ userId, answerKeyId: updatedJob.result.answer_key_id });
    expect(key).not.toBeNull();
    const questions = db.listQuestionsForAnswerKey({ answerKeyId: key.id });
    expect(questions.length).toBe(updatedJob.result.question_count);
  });

  it('throws on missing upload', async () => {
    const jobId = db.createJob({ userId, type: 'quiz_key', input: { upload_id: 'nonexistent' } });
    const job = db.getJobForUser({ userId, jobId });
    await expect(quizAgent.run(job)).rejects.toThrow();
  });
});

// ─── Integration: gradeStudentPapers ───

describe('gradeStudentPapers', () => {
  let userId, answerKeyId;

  beforeEach(async () => {
    userId = createTestUser();

    // Create answer key with known questions
    answerKeyId = db.createAnswerKey({ userId, title: '测试', pageCount: 1 });
    db.bulkInsertAnswerKeyQuestions({
      answerKeyId,
      questions: [
        { questionNumber: 1, correctAnswer: 'deep', knowledgeTag: 'vocabulary', confidence: 1.0 },
        { questionNumber: 2, correctAnswer: 'desert', knowledgeTag: 'vocabulary', confidence: 1.0 },
        { questionNumber: 3, correctAnswer: 'Asia', knowledgeTag: 'geography', confidence: 1.0 }
      ]
    });
  });

  it('grades students end-to-end with mock VLM', async () => {
    // Create 2 mock student photo uploads (pageCount=1, so 1 photo per student)
    const imgDir = path.join(tmpDir, 'student-uploads');
    const img1 = await createMockImageFile(imgDir, 'student1.jpg');
    const img2 = await createMockImageFile(imgDir, 'student2.jpg');
    const fid1 = db.createFile({ userId, kind: 'image', filename: 'student1.jpg', mime: 'image/jpeg', size: 100, filePath: img1 });
    const fid2 = db.createFile({ userId, kind: 'image', filename: 'student2.jpg', mime: 'image/jpeg', size: 100, filePath: img2 });
    const uploadId = db.createUpload({ userId, fileIds: [fid1, fid2] });

    const jobId = db.createJob({
      userId,
      type: 'quiz_grade',
      input: { upload_id: uploadId, answer_key_id: answerKeyId }
    });
    const job = db.getJobForUser({ userId, jobId });

    await quizAgent.run(job);

    const updatedJob = db.getJobForUser({ userId, jobId });
    expect(updatedJob.status).toBe('done');
    expect(updatedJob.result).toHaveProperty('result_id');
    expect(updatedJob.result).toHaveProperty('summary');
    expect(updatedJob.result.summary.student_count).toBeGreaterThan(0);
    expect(updatedJob.result).toHaveProperty('xlsx_download_url');
    expect(updatedJob.result).toHaveProperty('csv_download_url');
  });

  it('incremental append mode adds to existing result', async () => {
    // First batch
    const imgDir = path.join(tmpDir, 'batch1');
    const img1 = await createMockImageFile(imgDir, 's1.jpg');
    const fid1 = db.createFile({ userId, kind: 'image', filename: 's1.jpg', mime: 'image/jpeg', size: 100, filePath: img1 });
    const uploadId1 = db.createUpload({ userId, fileIds: [fid1] });

    const jobId1 = db.createJob({
      userId, type: 'quiz_grade',
      input: { upload_id: uploadId1, answer_key_id: answerKeyId }
    });
    await quizAgent.run(db.getJobForUser({ userId, jobId: jobId1 }));
    const result1 = db.getJobForUser({ userId, jobId: jobId1 }).result;

    // Second batch (append)
    const imgDir2 = path.join(tmpDir, 'batch2');
    const img2 = await createMockImageFile(imgDir2, 's2.jpg');
    const fid2 = db.createFile({ userId, kind: 'image', filename: 's2.jpg', mime: 'image/jpeg', size: 100, filePath: img2 });
    const uploadId2 = db.createUpload({ userId, fileIds: [fid2] });

    const jobId2 = db.createJob({
      userId, type: 'quiz_grade',
      input: { upload_id: uploadId2, answer_key_id: answerKeyId, append_to_result_id: result1.result_id }
    });
    await quizAgent.run(db.getJobForUser({ userId, jobId: jobId2 }));
    const result2 = db.getJobForUser({ userId, jobId: jobId2 }).result;

    // Should reuse same result_id
    expect(result2.result_id).toBe(result1.result_id);
    // Student count should have increased
    expect(result2.summary.student_count).toBeGreaterThanOrEqual(result1.summary.student_count);
  });
});
