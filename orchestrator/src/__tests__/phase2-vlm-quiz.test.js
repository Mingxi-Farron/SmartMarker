import { describe, it, expect, beforeEach } from 'vitest';

describe('Phase 2: VLM quiz methods (mockMode)', () => {
  let ModelClient;
  let client;

  beforeEach(async () => {
    ({ ModelClient } = await import('../agents/model-client.js'));
    client = new ModelClient({
      endpoint: 'http://test',
      apiKey: 'test-key',
      model: 'test-model',
      mockMode: true
    });
  });

  describe('extractAnswerKeyFromImages', () => {
    it('returns correct structure with page_count and questions', async () => {
      const result = await client.extractAnswerKeyFromImages({
        imagePaths: ['/tmp/a.jpg', '/tmp/b.jpg']
      });
      expect(result).toHaveProperty('page_count');
      expect(result).toHaveProperty('questions');
      expect(Array.isArray(result.questions)).toBe(true);
      expect(result.questions.length).toBeGreaterThan(0);
    });

    it('each question has required fields', async () => {
      const result = await client.extractAnswerKeyFromImages({
        imagePaths: ['/tmp/a.jpg']
      });
      for (const q of result.questions) {
        expect(q).toHaveProperty('number');
        expect(q).toHaveProperty('correct_answer');
        expect(q).toHaveProperty('knowledge_tag');
        expect(q).toHaveProperty('confidence');
        expect(typeof q.number).toBe('number');
        expect(typeof q.correct_answer).toBe('string');
        expect(typeof q.confidence).toBe('number');
      }
    });

    it('includes at least one low-confidence question', async () => {
      const result = await client.extractAnswerKeyFromImages({
        imagePaths: ['/tmp/a.jpg']
      });
      const lowConf = result.questions.filter((q) => q.confidence < 0.6);
      expect(lowConf.length).toBeGreaterThan(0);
    });

    it('throws on empty imagePaths', async () => {
      await expect(
        client.extractAnswerKeyFromImages({ imagePaths: [] })
      ).rejects.toThrow();
    });
  });

  describe('ocrStudentAnswers', () => {
    it('returns compact format string', async () => {
      const result = await client.ocrStudentAnswers({
        imagePaths: ['/tmp/student1.jpg']
      });
      expect(typeof result).toBe('string');
      expect(result).toContain('|');
      expect(result).toMatch(/\d+:/);
    });

    it('string starts with student name and id', async () => {
      const result = await client.ocrStudentAnswers({
        imagePaths: ['/tmp/student1.jpg']
      });
      const parts = result.split('|');
      expect(parts.length).toBeGreaterThanOrEqual(3);
      // First part is name, second is id number
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1].length).toBeGreaterThan(0);
    });

    it('throws on empty imagePaths', async () => {
      await expect(
        client.ocrStudentAnswers({ imagePaths: [] })
      ).rejects.toThrow();
    });
  });

  describe('verifyOcrMismatches', () => {
    it('returns array of verdicts matching input pairs', async () => {
      const pairs = [
        { questionNumber: 6, studentAnswer: 'achive', correctAnswer: 'achieve' },
        { questionNumber: 7, studentAnswer: 'seperate', correctAnswer: 'separate' }
      ];
      const result = await client.verifyOcrMismatches({ pairs });
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
    });

    it('each verdict has required fields', async () => {
      const pairs = [
        { questionNumber: 1, studentAnswer: 'achive', correctAnswer: 'achieve' }
      ];
      const result = await client.verifyOcrMismatches({ pairs });
      for (const v of result) {
        expect(v).toHaveProperty('question_number');
        expect(v).toHaveProperty('verdict');
        expect(v).toHaveProperty('confidence');
        expect(['correct', 'wrong']).toContain(v.verdict);
      }
    });

    it('returns empty array for empty input', async () => {
      const result = await client.verifyOcrMismatches({ pairs: [] });
      expect(result).toEqual([]);
    });
  });

  describe('planMainAction validIntents', () => {
    it('quiz_grade is a valid intent', async () => {
      // planMainAction returns null in mockMode, so we test via non-mock with a spy
      const nonMockClient = new ModelClient({
        endpoint: 'http://test',
        apiKey: 'test-key',
        model: 'test-model',
        mockMode: false
      });
      // Spy on chatCompletion to return a quiz_grade intent
      nonMockClient.chatCompletion = async () => JSON.stringify({
        intent: 'quiz_grade',
        device_action: null,
        device_payload: {},
        weather_city: null,
        weather_write_path: null,
        essay_topic: null,
        reason: '用户要批改过关单'
      });
      const result = await nonMockClient.planMainAction({ message: '批改过关单' });
      expect(result).not.toBeNull();
      expect(result.intent).toBe('quiz_grade');
    });
  });
});
