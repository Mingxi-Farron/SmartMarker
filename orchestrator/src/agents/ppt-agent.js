export class PptAgent {
  constructor({ db, modelClient, pptClient, storage }) {
    this.db = db;
    this.modelClient = modelClient;
    this.pptClient = pptClient;
    this.storage = storage;
  }

  async run(job) {
    const { id: jobId, user_id: userId, input } = job;
    if (!input?.upload_id) {
      throw new Error('缺少 upload_id');
    }

    const upload = this.db.getUploadWithFiles({ userId, uploadId: input.upload_id });
    if (!upload || upload.files.length === 0) {
      throw new Error('未找到上传图片');
    }

    this.db.updateJob({ jobId, status: 'extracting_text' });
    const blocks = [];
    const failedExtracts = [];
    for (const item of upload.files) {
      try {
        const text = await this.modelClient.extractTextFromImage(item.path);
        blocks.push(`## ${item.filename}\n${text}`);
      } catch (err) {
        failedExtracts.push({
          filename: item.filename,
          error: String(err?.message || '未知错误')
        });
        blocks.push(`## ${item.filename}\n[图片转写失败，已启用兜底流程]`);
      }
    }

    const mergedText = blocks.join('\n\n');
    const mergedSaved = await this.storage.writeText({
      userId,
      category: 'outputs',
      originalName: `job-${jobId}-merged.txt`,
      text: mergedText
    });
    const mergedBuffer = await this.storage.readFile(mergedSaved.path);
    const mergedFileId = this.db.createFile({
      userId,
      kind: 'text',
      filename: mergedSaved.filename,
      mime: 'text/plain',
      size: mergedBuffer.length,
      filePath: mergedSaved.path
    });

    const userPrompt = String(input?.prompt || '');
    const { outline, reasoning } = await this.modelClient.generateOutlineWithReasoning({
      mergedText,
      request: userPrompt,
    });
    this.db.updateJob({
      jobId,
      status: 'outline_ready',
      result: {
        merged_text_file_id: mergedFileId,
        outline,
        reasoning,
        prompt: userPrompt,
        extract_warnings: failedExtracts
      }
    });

    this.db.updateJob({ jobId, status: 'ppt_generating' });
    const ppt = await this.pptClient.generate({
      userId,
      outline,
      request: userPrompt,
      reasoning,
    });
    this.db.updateJob({
      jobId,
      status: 'done',
      result: {
        merged_text_file_id: mergedFileId,
        outline,
        reasoning,
        prompt: userPrompt,
        extract_warnings: failedExtracts,
        ...ppt
      }
    });
  }
}
