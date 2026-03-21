export class JobWorker {
  constructor({ db, pptAgent, gradesAgent, quizAgent, essayAgent, logger }) {
    this.db = db;
    this.pptAgent = pptAgent;
    this.gradesAgent = gradesAgent;
    this.quizAgent = quizAgent;
    this.essayAgent = essayAgent;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start(intervalMs = 1500) {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error({ err }, 'job tick failed');
      });
    }, intervalMs);
    this.logger.info('job worker started');
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    if (this.running) {
      return;
    }
    this.running = true;
    let currentJob = null;
    try {
      currentJob = this.db.takeQueuedJob();
      if (!currentJob) {
        return;
      }

      if (currentJob.type === 'ppt') {
        await this.pptAgent.run(currentJob);
      } else if (currentJob.type === 'grades') {
        await this.gradesAgent.run(currentJob);
      } else if (currentJob.type === 'quiz_key' || currentJob.type === 'quiz_grade') {
        await this.quizAgent.run(currentJob);
      } else if (currentJob.type === 'essay_review') {
        await this.essayAgent.run(currentJob);
      } else {
        this.db.updateJob({
          jobId: currentJob.id,
          status: 'failed',
          error: `未知任务类型: ${currentJob.type}`
        });
      }
    } catch (err) {
      if (err?.message && err?.stack) {
        this.logger.error({ err }, 'job execution failed');
      }
      if (currentJob) {
        this.db.updateJob({
          jobId: currentJob.id,
          status: 'failed',
          error: err?.message || '任务失败'
        });
      }
    } finally {
      this.running = false;
    }
  }
}
