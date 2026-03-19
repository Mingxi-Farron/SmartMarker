import path from 'node:path';
import { randomUUID } from 'node:crypto';
import PptxGenJS from 'pptxgenjs';

function ensurePages(outline) {
  if (!outline || !Array.isArray(outline.pages) || outline.pages.length === 0) {
    throw new Error('PPT 大纲为空');
  }
}

function safeStr(value, fallback = '') {
  const out = String(value || '').trim();
  return out || fallback;
}

function detectTheme(request = '', title = '') {
  const text = `${request} ${title}`.toLowerCase();
  if (/活泼|明快|轻快|年轻|卡通|有趣/.test(text)) {
    return {
      name: 'lively',
      bg: 'F8FBFF',
      accent: '0077B6',
      accent2: '00A6FB',
      text: '0F172A',
      light: 'E8F4FF',
      coverBg: '0077B6',
      coverText: 'FFFFFF',
    };
  }
  if (/学术|严谨|研究|论文|专业|正式/.test(text)) {
    return {
      name: 'academic',
      bg: 'F7F8FB',
      accent: '283593',
      accent2: '5C6BC0',
      text: '111827',
      light: 'ECEFF7',
      coverBg: '1E2A78',
      coverText: 'FFFFFF',
    };
  }
  return {
    name: 'minimal',
    bg: 'F8FAFC',
    accent: '2D63FF',
    accent2: '7FA3FF',
    text: '0F172A',
    light: 'EEF3FF',
    coverBg: '2D63FF',
    coverText: 'FFFFFF',
  };
}

function extractPptUrlFromPayload(payload) {
  const direct =
    payload?.ppt_url ||
    payload?.result?.ppt_url ||
    payload?.result?.details?.ppt_url ||
    payload?.data?.ppt_url ||
    payload?.output?.ppt_url ||
    null;
  if (direct && /^https?:\/\//i.test(String(direct))) {
    return String(direct);
  }

  const textCandidates = [];
  if (typeof payload?.result?.content === 'string') {
    textCandidates.push(payload.result.content);
  }
  if (Array.isArray(payload?.result?.content)) {
    for (const part of payload.result.content) {
      if (typeof part?.text === 'string') {
        textCandidates.push(part.text);
      } else if (typeof part === 'string') {
        textCandidates.push(part);
      }
    }
  }

  for (const text of textCandidates) {
    const hit = String(text).match(/https?:\/\/[^\s"'`<>]+/i);
    if (hit?.[0]) {
      return hit[0];
    }
  }
  return null;
}

function trimErr(err) {
  return String(err?.message || err || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

export class PptClient {
  constructor({
    openclawBaseUrl,
    openclawApiKey,
    openclawGatewayToken,
    openclawPptTool,
    openclawPptToolArgSkillKey,
    pptSkill,
    publicBaseUrl,
    storage,
    db,
    mockMode,
  }) {
    this.openclawBaseUrl = openclawBaseUrl;
    this.openclawApiKey = openclawApiKey;
    this.openclawGatewayToken = openclawGatewayToken;
    this.openclawPptTool = openclawPptTool || 'skills_run';
    this.openclawPptToolArgSkillKey = openclawPptToolArgSkillKey || 'skill';
    this.pptSkill = pptSkill;
    this.publicBaseUrl = publicBaseUrl;
    this.storage = storage;
    this.db = db;
    this.mockMode = mockMode;
  }

  getNormalizedBase() {
    return String(this.openclawBaseUrl || '').replace(/\/$/, '');
  }

  async tryOpenClawTools(outline) {
    const base = this.getNormalizedBase();
    const token = safeStr(this.openclawGatewayToken);
    if (!base || !token) {
      return null;
    }

    const args = {
      input: {
        outline,
      },
    };
    args[this.openclawPptToolArgSkillKey] = this.pptSkill;

    const res = await fetch(`${base}/tools/invoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        tool: this.openclawPptTool,
        args,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openclaw/tools ${res.status}: ${text || 'empty response'}`);
    }

    const data = await res.json();
    const pptUrl = extractPptUrlFromPayload(data);
    if (!pptUrl) {
      throw new Error('openclaw/tools 未返回可用 ppt_url');
    }
    return {
      provider: 'openclaw-tools',
      ppt_url: pptUrl,
    };
  }

  async tryOpenClawLegacy(outline) {
    const base = this.getNormalizedBase();
    const token = safeStr(this.openclawApiKey || this.openclawGatewayToken);
    if (!base || !token) {
      return null;
    }

    const res = await fetch(`${base}/skills/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        skill: this.pptSkill,
        input: { outline },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openclaw/legacy ${res.status}: ${text || 'empty response'}`);
    }
    const data = await res.json();
    const pptUrl = extractPptUrlFromPayload(data);
    if (!pptUrl) {
      throw new Error('openclaw/legacy 未返回可用 ppt_url');
    }
    return {
      provider: 'openclaw-legacy',
      ppt_url: pptUrl,
    };
  }

  addCoverSlide({ pptx, outline, request, theme }) {
    const cover = pptx.addSlide();
    cover.background = { color: theme.coverBg };
    cover.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.33,
      h: 0.28,
      fill: { color: theme.accent2 },
      line: { color: theme.accent2 },
    });
    cover.addText(safeStr(outline?.title, '自动生成课件'), {
      x: 0.8,
      y: 1.35,
      w: 11.8,
      h: 1,
      fontFace: 'Microsoft YaHei',
      fontSize: 38,
      bold: true,
      color: theme.coverText,
      align: 'left',
      valign: 'mid',
    });
    cover.addText(safeStr(request, '基于教材内容自动生成（教师授课版）'), {
      x: 0.82,
      y: 2.55,
      w: 11.8,
      h: 1.1,
      fontFace: 'Microsoft YaHei',
      fontSize: 18,
      color: theme.coverText,
      valign: 'top',
    });
    cover.addText(`页数：${outline?.pages?.length || 0} 页`, {
      x: 0.82,
      y: 6.7,
      w: 4,
      h: 0.5,
      fontFace: 'Microsoft YaHei',
      fontSize: 13,
      color: 'DCE7FF',
    });
  }

  addContentSlide({ pptx, page, index, total, theme }) {
    const slide = pptx.addSlide();
    slide.background = { color: theme.bg };

    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.33,
      h: 0.86,
      fill: { color: theme.accent },
      line: { color: theme.accent },
    });
    slide.addText(page.title || `第 ${index + 1} 页`, {
      x: 0.55,
      y: 0.16,
      w: 12,
      h: 0.45,
      fontFace: 'Microsoft YaHei',
      fontSize: 23,
      bold: true,
      color: 'FFFFFF',
    });

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.58,
      y: 1.15,
      w: 0.12,
      h: 4.95,
      fill: { color: theme.accent2 },
      line: { color: theme.accent2 },
      radius: 0.04,
    });

    const bullets = Array.isArray(page.bullet_points) ? page.bullet_points.slice(0, 10) : [];
    const left = bullets.slice(0, 5);
    const right = bullets.slice(5, 10);

    let yLeft = 1.26;
    for (const item of left) {
      slide.addText(`• ${item}`, {
        x: 0.9,
        y: yLeft,
        w: 5.8,
        h: 0.58,
        fontFace: 'Microsoft YaHei',
        fontSize: 19,
        color: theme.text,
      });
      yLeft += 0.76;
    }

    if (right.length) {
      slide.addShape(pptx.ShapeType.rect, {
        x: 6.85,
        y: 1.12,
        w: 0.04,
        h: 4.8,
        fill: { color: 'D6DDF1' },
        line: { color: 'D6DDF1' },
      });
      let yRight = 1.26;
      for (const item of right) {
        slide.addText(`• ${item}`, {
          x: 7.15,
          y: yRight,
          w: 5.8,
          h: 0.58,
          fontFace: 'Microsoft YaHei',
          fontSize: 18,
          color: theme.text,
        });
        yRight += 0.76;
      }
    }

    if (page.notes) {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: 0.74,
        y: 6.08,
        w: 12.05,
        h: 1.04,
        fill: { color: theme.light },
        line: { color: theme.light },
        radius: 0.08,
      });
      slide.addText(`教学提示：${page.notes}`, {
        x: 0.92,
        y: 6.28,
        w: 11.7,
        h: 0.68,
        fontFace: 'Microsoft YaHei',
        fontSize: 13,
        color: '334155',
      });
      slide.addNotes(`讲稿：${page.notes}`);
    }

    slide.addText(`${index + 1}/${total}`, {
      x: 12.3,
      y: 0.2,
      w: 0.8,
      h: 0.4,
      fontFace: 'Microsoft YaHei',
      fontSize: 11,
      color: 'DDE7FF',
      align: 'right',
    });
  }

  async buildLocalPptx({ userId, outline, request = '' }) {
    ensurePages(outline);
    const theme = detectTheme(request, outline.title);
    const pptx = new PptxGenJS();
    pptx.author = 'Teacher AI Assistant';
    pptx.company = 'MVP';
    pptx.layout = 'LAYOUT_WIDE';
    pptx.subject = outline.title || '自动生成课件';
    pptx.title = outline.title || '自动生成课件';

    this.addCoverSlide({ pptx, outline, request, theme });
    outline.pages.forEach((page, idx) => {
      this.addContentSlide({
        pptx,
        page,
        index: idx,
        total: outline.pages.length,
        theme,
      });
    });

    const tmpName = `ppt-${randomUUID()}.pptx`;
    const { path: outPath } = await this.storage.saveBuffer({
      userId,
      category: 'outputs',
      originalName: tmpName,
      buffer: Buffer.alloc(0),
    });

    await pptx.writeFile({ fileName: outPath });
    const stats = await this.storage.readFile(outPath);
    const fileId = this.db.createFile({
      userId,
      kind: 'ppt',
      filename: path.basename(outPath),
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: stats.length,
      filePath: outPath,
    });

    return {
      provider: this.mockMode ? 'mock' : 'local-fallback-enhanced',
      file_id: fileId,
      ppt_url: `${this.publicBaseUrl}/download/${fileId}`,
    };
  }

  async generate({ userId, outline, request = '' }) {
    ensurePages(outline);
    const providerErrors = [];

    if (!this.mockMode) {
      try {
        const toolsResult = await this.tryOpenClawTools(outline);
        if (toolsResult) {
          return toolsResult;
        }
      } catch (err) {
        providerErrors.push(trimErr(err));
      }

      try {
        const legacyResult = await this.tryOpenClawLegacy(outline);
        if (legacyResult) {
          return legacyResult;
        }
      } catch (err) {
        providerErrors.push(trimErr(err));
      }
    }

    const local = await this.buildLocalPptx({ userId, outline, request });
    if (providerErrors.length) {
      return {
        ...local,
        provider_error: providerErrors.join(' | '),
      };
    }
    return local;
  }
}
