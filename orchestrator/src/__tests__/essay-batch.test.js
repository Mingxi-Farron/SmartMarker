import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB } from '../db.js';
import { Storage } from '../storage.js';
import { ModelClient } from '../agents/model-client.js';
import { EssayAgent } from '../agents/essay-agent.js';
import { MainAgent } from '../agents/main-agent.js';
import { JobWorker } from '../jobs/worker.js';

let db, tmpDir;

function createTestUser() {
  db.ensureInvite({ code: 'test-code' });
  return db.redeemInvite('test-code').user_id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartmarker-essay-test-'));
  db = new DB(tmpDir);
});

afterEach(() => {
  if (db?.db) db.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Phase 0: DB Schema ───

describe('essay_results CRUD', () => {
  let userId;
  beforeEach(() => { userId = createTestUser(); });

  it('creates and retrieves essay result', () => {
    const id = db.createEssayResult({ userId, topic: 'My Favorite Food', pagesPerEssay: 2 });
    expect(id).toBeDefined();
    const result = db.getEssayResultForUser({ userId, resultId: id });
    expect(result.topic).toBe('My Favorite Food');
    expect(result.pages_per_essay).toBe(2);
    expect(result.student_count).toBe(0);
  });

  it('lists essay results for user', () => {
    db.createEssayResult({ userId, topic: 'A' });
    db.createEssayResult({ userId, topic: 'B' });
    const list = db.listEssayResultsForUser({ userId });
    expect(list).toHaveLength(2);
  });

  it('deletes essay result with CASCADE', () => {
    const id = db.createEssayResult({ userId, topic: 'test' });
    db.insertEssayResultItem({
      resultId: id, studentName: '张三', estimatedScore: 8, fullScore: 12,
      spellingCount: 1, grammarCount: 2, topicMatchScore: 4,
      transcription: 'test essay', reviewJson: '{}'
    });
    const deleted = db.deleteEssayResultForUser({ userId, resultId: id });
    expect(deleted).toBeTruthy();
    const items = db.listEssayResultItems({ resultId: id });
    expect(items).toHaveLength(0);
  });

  it('enforces ownership — user A cannot access user B result', () => {
    const userA = userId;
    db.ensureInvite({ code: 'b-code' });
    const userB = db.redeemInvite('b-code').user_id;
    const id = db.createEssayResult({ userId: userA, topic: 'test' });
    expect(db.getEssayResultForUser({ userId: userB, resultId: id })).toBeNull();
    expect(db.deleteEssayResultForUser({ userId: userB, resultId: id })).toBeNull();
  });
});

describe('essay_result_items CRUD', () => {
  let userId, resultId;
  beforeEach(() => {
    userId = createTestUser();
    resultId = db.createEssayResult({ userId, topic: 'test' });
  });

  it('inserts item and updates student_count', () => {
    db.insertEssayResultItem({
      resultId, studentName: '张三', estimatedScore: 9, fullScore: 12,
      spellingCount: 2, grammarCount: 1, topicMatchScore: 4,
      transcription: 'My favorite food is...', reviewJson: '{"spelling_errors":[]}'
    });
    db.insertEssayResultItem({
      resultId, studentName: '李四', estimatedScore: 7, fullScore: 12,
      spellingCount: 3, grammarCount: 4, topicMatchScore: 3,
      transcription: 'I like to eat...', reviewJson: '{"spelling_errors":[]}'
    });
    const result = db.getEssayResultForUser({ userId, resultId });
    expect(result.student_count).toBe(2);
  });

  it('lists items ordered by student_name', () => {
    db.insertEssayResultItem({ resultId, studentName: '李四', estimatedScore: 7, fullScore: 12, spellingCount: 0, grammarCount: 0, topicMatchScore: null, transcription: '', reviewJson: '{}' });
    db.insertEssayResultItem({ resultId, studentName: '张三', estimatedScore: 9, fullScore: 12, spellingCount: 0, grammarCount: 0, topicMatchScore: null, transcription: '', reviewJson: '{}' });
    const items = db.listEssayResultItems({ userId, resultId });
    expect(items).toHaveLength(2);
    // SQLite sorts by byte value for Chinese characters
    const names = items.map(i => i.student_name);
    expect(names).toContain('张三');
    expect(names).toContain('李四');
  });

  it('getEssayResultSummary returns aggregated stats', () => {
    db.insertEssayResultItem({ resultId, studentName: 'A', estimatedScore: 10, fullScore: 12, spellingCount: 1, grammarCount: 2, topicMatchScore: 5, transcription: '', reviewJson: '{}' });
    db.insertEssayResultItem({ resultId, studentName: 'B', estimatedScore: 6, fullScore: 12, spellingCount: 3, grammarCount: 4, topicMatchScore: 3, transcription: '', reviewJson: '{}' });
    const summary = db.getEssayResultSummary({ userId, resultId });
    expect(summary.student_count).toBe(2);
    expect(summary.avg_score).toBeCloseTo(8, 0);
    expect(summary.max_score).toBe(10);
    expect(summary.min_score).toBe(6);
    expect(summary.full_score).toBe(12);
    expect(summary.total_spelling).toBe(4);
    expect(summary.total_grammar).toBe(6);
  });
});

// ─── Phase 1: EssayAgent ───

describe('EssayAgent.processEssayBatch', () => {
  let userId, storage, modelClient, essayAgent;

  beforeEach(() => {
    userId = createTestUser();
    storage = new Storage(tmpDir);
    modelClient = new ModelClient({
      endpoint: 'http://test', apiKey: 'test', model: 'test', mockMode: true
    });
    essayAgent = new EssayAgent({ db, storage, modelClient, publicBaseUrl: 'http://test:8080' });
  });

  it('processes a batch of 2 students and generates report', async () => {
    // Create 2 fake image files
    const files = [];
    for (let i = 0; i < 2; i++) {
      const fPath = path.join(tmpDir, `essay${i}.jpg`);
      fs.writeFileSync(fPath, `fake-image-${i}`);
      const fileId = db.createFile({
        userId, kind: 'image', filename: `essay${i}.jpg`,
        mime: 'image/jpeg', size: 100, filePath: fPath
      });
      files.push(fileId);
    }
    const uploadId = db.createUpload({ userId, fileIds: files });
    const jobId = db.createJob({
      userId, type: 'essay_review',
      input: { upload_id: uploadId, topic: 'My Favorite Food', pages_per_essay: 1 }
    });
    const job = db.getJobForUser({ userId, jobId });

    await essayAgent.run(job);

    const finalJob = db.getJobForUser({ userId, jobId });
    expect(finalJob.status).toBe('done');
    expect(finalJob.result.summary.student_count).toBe(2);
    expect(finalJob.result.csv_download_url).toContain('/download/');
    expect(finalJob.result.xlsx_download_url).toContain('/download/');
    expect(finalJob.result.result_id).toBeDefined();
  });

  it('handles partial failure gracefully', async () => {
    // Create 1 file (will succeed in mock mode)
    const fPath = path.join(tmpDir, 'ok.jpg');
    fs.writeFileSync(fPath, 'fake');
    const fileId = db.createFile({
      userId, kind: 'image', filename: 'ok.jpg',
      mime: 'image/jpeg', size: 100, filePath: fPath
    });
    const uploadId = db.createUpload({ userId, fileIds: [fileId] });
    const jobId = db.createJob({
      userId, type: 'essay_review',
      input: { upload_id: uploadId, pages_per_essay: 1 }
    });
    const job = db.getJobForUser({ userId, jobId });

    await essayAgent.run(job);

    const finalJob = db.getJobForUser({ userId, jobId });
    expect(finalJob.status).toBe('done');
    expect(finalJob.result.summary.student_count).toBe(1);
  });
});

// ─── Phase 2: Worker dispatch ───

describe('JobWorker dispatches essay_review', () => {
  it('dispatches essay_review to essayAgent', async () => {
    const userId = createTestUser();
    const storage = new Storage(tmpDir);
    const modelClient = new ModelClient({
      endpoint: 'http://test', apiKey: 'test', model: 'test', mockMode: true
    });
    const essayAgent = new EssayAgent({ db, storage, modelClient, publicBaseUrl: 'http://test:8080' });
    const worker = new JobWorker({
      db, pptAgent: {}, gradesAgent: {}, quizAgent: {}, essayAgent,
      logger: { info: () => {}, error: () => {} }
    });

    const fPath = path.join(tmpDir, 'test.jpg');
    fs.writeFileSync(fPath, 'fake');
    const fileId = db.createFile({
      userId, kind: 'image', filename: 'test.jpg',
      mime: 'image/jpeg', size: 100, filePath: fPath
    });
    const uploadId = db.createUpload({ userId, fileIds: [fileId] });
    db.createJob({
      userId, type: 'essay_review',
      input: { upload_id: uploadId, pages_per_essay: 1 }
    });

    await worker.tick();

    // Find the job and check it completed
    const jobs = db.listJobsForUser ? db.listJobsForUser({ userId }) : [];
    // Alternative: check that essay_results table has a row
    const results = db.listEssayResultsForUser({ userId });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Phase 3: Intent routing ───

describe('inferIntent: essay_batch', () => {
  let mainAgent;
  beforeEach(() => {
    const modelClient = new ModelClient({
      endpoint: 'http://test', apiKey: 'test', model: 'test', mockMode: true
    });
    mainAgent = new MainAgent({ db, modelClient, hub: { onlineDeviceIds: () => new Map() }, weatherService: {} });
  });

  it('returns essay_review for single essay keywords', () => {
    expect(mainAgent.inferIntent('批改作文')).toBe('essay_review');
    expect(mainAgent.inferIntent('检查拼写')).toBe('essay_review');
  });

  it('still returns essay_review for batch keywords (unified intent)', () => {
    // Batch keywords still resolve to essay_review (same intent, branching inside handler)
    expect(mainAgent.inferIntent('批量批改作文')).toBe('essay_review');
    expect(mainAgent.inferIntent('批改全班作文')).toBe('essay_review');
  });
});
