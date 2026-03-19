import fs from 'node:fs/promises';
import path from 'node:path';

function parseJsonBlock(text) {
  if (!text) {
    return null;
  }
  const trimmed = String(text).trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  const match = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function toTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const chunks = content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part.text === 'string') {
          return part.text;
        }
        if (part && part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean);
    return chunks.join('\n').trim();
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }

  return content == null ? '' : JSON.stringify(content);
}

function clampNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function safeString(value, fallback = '') {
  const out = value == null ? '' : String(value).trim();
  return out || fallback;
}

function pickFirst(obj, keys = []) {
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) {
      return obj[key];
    }
  }
  return null;
}

function toBulletArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8);
  }
  const raw = String(value || '').trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(/\r?\n|[；;。]/)
    .map((line) => line.replace(/^[-*•\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function sanitizeJsonString(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
}

function extractCodeBlocks(text) {
  const out = [];
  const regex = /```(?:json|javascript|js|txt|markdown)?\s*([\s\S]*?)\s*```/gi;
  let m = null;
  while ((m = regex.exec(String(text || ''))) != null) {
    if (m[1]) {
      out.push(m[1]);
    }
  }
  return out;
}

function extractBalancedObjects(text, maxCount = 6) {
  const str = String(text || '');
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(str.slice(start, i + 1));
        start = -1;
        if (out.length >= maxCount) {
          break;
        }
      }
    }
  }
  return out;
}

function parseJsonMaybe(text) {
  const cleaned = sanitizeJsonString(text);
  if (!cleaned) {
    return null;
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function normalizeOutlineObject(raw, fallbackTitle = '教材自动生成课件') {
  if (!raw) {
    return null;
  }

  let title = fallbackTitle;
  let pagesRaw = null;
  if (Array.isArray(raw)) {
    pagesRaw = raw;
  } else if (typeof raw === 'object') {
    title = safeString(
      pickFirst(raw, ['title', 'ppt_title', 'deck_title', '标题', '主题']) || fallbackTitle,
      fallbackTitle,
    );
    pagesRaw = pickFirst(raw, ['pages', 'slides', '页面', '幻灯片', '内容']);
  }

  if (!Array.isArray(pagesRaw) || pagesRaw.length === 0) {
    return null;
  }

  const pages = pagesRaw
    .map((item, idx) => {
      if (typeof item === 'string') {
        return {
          title: item.trim() || `第 ${idx + 1} 页`,
          bullet_points: [],
          notes: '',
        };
      }
      if (!item || typeof item !== 'object') {
        return null;
      }
      const pageTitle = safeString(
        pickFirst(item, ['title', 'page_title', 'name', '标题', '页面标题']) || `第 ${idx + 1} 页`,
        `第 ${idx + 1} 页`,
      );
      const bullets = toBulletArray(
        pickFirst(item, ['bullet_points', 'bulletPoints', 'bullets', 'points', '要点', '要点列表']),
      );
      const notes = safeString(pickFirst(item, ['notes', 'note', 'speaker_notes', '讲稿', '备注']), '');
      return {
        title: pageTitle,
        bullet_points: bullets,
        notes,
      };
    })
    .filter(Boolean)
    .slice(0, 20);

  if (!pages.length) {
    return null;
  }
  return { title, pages };
}

function parseRequestedPageCount(request, fallback = null) {
  const text = String(request || '');
  const hit = text.match(/(\d{1,2})\s*页/);
  if (!hit?.[1]) {
    return fallback;
  }
  const count = Number(hit[1]);
  if (!Number.isFinite(count)) {
    return fallback;
  }
  return Math.min(20, Math.max(2, Math.floor(count)));
}

function buildFallbackOutlineFromText(mergedText, pageCount = null) {
  const lines = String(mergedText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('## '));

  const title = safeString(lines[0], '教材自动生成课件').slice(0, 36);
  const snippets = lines
    .map((line) => line.replace(/^[-*•\d.\s]+/, '').trim())
    .filter((line) => line.length >= 4)
    .slice(0, 80);

  const fallbackText = snippets.length ? snippets : ['围绕教材核心内容展开讲解', '结合课堂活动进行巩固练习'];
  const pickBullets = (offset) => {
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      out.push(fallbackText[(offset + i) % fallbackText.length]);
    }
    return out;
  };

  const titles = [
    '课程导入',
    '学习目标',
    '核心概念',
    '重点知识一',
    '重点知识二',
    '案例讲解',
    '课堂练习',
    '总结与作业',
    '复习巩固',
    '作业与反馈',
  ];
  const targetPages = Math.min(titles.length, Math.max(2, Number(pageCount) || 8));
  const pages = titles.slice(0, targetPages).map((t, idx) => ({
    title: t,
    bullet_points: pickBullets(idx * 2),
    notes: '可结合教材原文与课堂互动展开讲解。',
  }));
  return { title, pages };
}

function buildPptReasoningFallback({ request, mergedText, outline }) {
  const textLines = String(mergedText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 30);
  const pageCount = Array.isArray(outline?.pages) ? outline.pages.length : 0;
  const topKeywords = textLines
    .filter((line) => line.length >= 4 && !line.startsWith('## '))
    .slice(0, 6)
    .map((line) => `- ${line.slice(0, 40)}`);
  const slideTitles = (outline?.pages || []).slice(0, 10).map((page, idx) => `${idx + 1}. ${page.title || `第 ${idx + 1} 页`}`);

  return [
    `用户需求：${String(request || '根据教材图片生成授课PPT').trim()}。`,
    '',
    '**1. 图片文本理解要点：**',
    ...(topKeywords.length ? topKeywords : ['- 已从教材图片提取课程主题、知识点和课堂活动信息。']),
    '',
    '**2. 教学目标与受众：**',
    '- 受众为任课老师，PPT需突出教学重难点、课堂组织与讲解顺序。',
    '- 目标是把教材目录与知识结构转为可直接授课的页面框架。',
    '',
    `**3. 结构规划（共 ${pageCount || 'N'} 页）：**`,
    ...(slideTitles.length ? slideTitles.map((line) => `- ${line}`) : ['- 正在按“导入-讲解-练习-总结”组织页面。']),
    '',
    '**4. 产出检查：**',
    '- 已确保每页包含标题、要点和讲稿提示（notes）。',
    '- 若在线技能不可用，将自动回退到本地渲染模板，保证可下载。',
  ].join('\n');
}

function normalizeReviewIssue(item) {
  if (typeof item === 'string') {
    const text = item.trim();
    if (!text) {
      return null;
    }
    return {
      original: text,
      suggestion: '',
      reason: '',
    };
  }

  if (!item || typeof item !== 'object') {
    return null;
  }

  const original = safeString(
    pickFirst(item, ['original', 'source', 'text', '片段', '原句', '错误片段']),
    '',
  );
  const suggestion = safeString(
    pickFirst(item, ['suggestion', 'correction', 'fixed', '修改建议', '修正', '推荐写法']),
    '',
  );
  const reason = safeString(
    pickFirst(item, ['reason', 'explanation', 'note', '原因', '说明']),
    '',
  );

  if (!original && !suggestion && !reason) {
    return null;
  }

  return {
    original,
    suggestion,
    reason,
  };
}

function normalizeReviewIssueArray(value, limit = 8) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => normalizeReviewIssue(item)).filter(Boolean).slice(0, limit);
}

function normalizeStringArray(value, limit = 10) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, limit);
  }
  const raw = String(value || '').trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(/\r?\n|[；;]/)
    .map((item) => item.replace(/^[-*•\d.\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeRubricItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const criterion = safeString(
    pickFirst(item, ['criterion', 'item', 'requirement', 'rubric', '评分项', '要求项']),
    '',
  );
  const maxRaw = pickFirst(item, ['max_score', 'full_score', 'points', '满分']);
  const awardedRaw = pickFirst(item, ['awarded_score', 'score', 'got', '得分']);
  const reason = safeString(
    pickFirst(item, ['reason', 'comment', 'note', '说明', '评语']),
    '',
  );
  const maxScore = Number.isFinite(Number(maxRaw)) ? Number(maxRaw) : null;
  const awardedScore = Number.isFinite(Number(awardedRaw)) ? Number(awardedRaw) : null;

  if (!criterion && maxScore == null && awardedScore == null && !reason) {
    return null;
  }

  return {
    criterion,
    max_score: maxScore,
    awarded_score: awardedScore,
    reason,
  };
}

function normalizeRubricArray(value, limit = 12) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => normalizeRubricItem(item)).filter(Boolean).slice(0, limit);
}

function normalizeEssayReview(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const scoreRaw = pickFirst(raw, ['topic_match_score', 'match_score', 'score', '主题匹配分']);
  const scoreNum = Number(scoreRaw);
  const topicMatchScore = Number.isFinite(scoreNum)
    ? Math.min(5, Math.max(1, Math.round(scoreNum)))
    : null;

  return {
    transcription: safeString(
      pickFirst(raw, ['transcription', 'essay_text', 'text', 'ocr_text', '转写文本', '作文文本']),
      '',
    ),
    requirement_summary: normalizeStringArray(
      pickFirst(raw, ['requirement_summary', 'requirements', 'rubric_summary', '任务要求', '要求摘要']),
      10,
    ),
    requirement_mismatches: normalizeStringArray(
      pickFirst(raw, ['requirement_mismatches', 'missing_requirements', 'gaps', 'requirements_diff', '与要求不符项', '缺失项']),
      10,
    ),
    scoring_breakdown: normalizeRubricArray(
      pickFirst(raw, ['scoring_breakdown', 'score_breakdown', 'rubric_scores', '得分拆解', '评分明细']),
      12,
    ),
    estimated_score: Number.isFinite(Number(pickFirst(raw, ['estimated_score', 'score_obtained', 'total_score', '总得分'])))
      ? Number(pickFirst(raw, ['estimated_score', 'score_obtained', 'total_score', '总得分']))
      : null,
    full_score: Number.isFinite(Number(pickFirst(raw, ['full_score', 'max_score', 'total_possible_score', '满分'])))
      ? Number(pickFirst(raw, ['full_score', 'max_score', 'total_possible_score', '满分']))
      : null,
    score_reason: safeString(
      pickFirst(raw, ['score_reason', 'scoring_reason', 'total_score_reason', '总分说明']),
      '',
    ),
    topic_match_score: topicMatchScore,
    topic_match_reason: safeString(
      pickFirst(raw, ['topic_match_reason', 'match_reason', 'score_reason', '主题匹配说明', '匹配原因']),
      '',
    ),
    spelling_errors: normalizeReviewIssueArray(
      pickFirst(raw, ['spelling_errors', 'spelling', 'spell_errors', '拼写错误']),
      8,
    ),
    grammar_issues: normalizeReviewIssueArray(
      pickFirst(raw, ['grammar_issues', 'sentence_issues', 'grammar_errors', '病句问题', '语法问题']),
      8,
    ),
    overall_feedback: safeString(
      pickFirst(raw, ['overall_feedback', 'feedback', 'summary', '总评', '整体建议']),
      '',
    ),
  };
}

export class ModelClient {
  constructor({ endpoint, apiKey, model, mockMode, disableThinking = true, requestTimeoutMs = 30000, maxTokens = 1200 }) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.model = model;
    this.mockMode = mockMode;
    this.disableThinking = Boolean(disableThinking);
    this.requestTimeoutMs = clampNumber(requestTimeoutMs, 30000, { min: 3000, max: 120000 });
    this.maxTokens = clampNumber(maxTokens, 1200, { min: 128, max: 8192 });
  }

  shouldRetryWithoutThinking(errorText = '') {
    const text = String(errorText || '').toLowerCase();
    return (
      text.includes('enable_thinking') ||
      text.includes('extra_body') ||
      text.includes('unknown') ||
      text.includes('unsupported') ||
      text.includes('invalid parameter') ||
      text.includes('additional properties')
    );
  }

  async doChatRequest(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!res.ok) {
        const txt = await res.text();
        return {
          ok: false,
          status: res.status,
          errorText: txt
        };
      }

      const data = await res.json();
      return {
        ok: true,
        status: res.status,
        data
      };
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`模型请求超时（>${this.requestTimeoutMs}ms）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async chatCompletion({ messages, temperature = 0.2, maxTokens }) {
    const resolvedMaxTokens = maxTokens != null
      ? clampNumber(maxTokens, this.maxTokens, { min: 128, max: 8192 })
      : this.maxTokens;
    const basePayload = {
      model: this.model,
      messages,
      temperature,
      max_tokens: resolvedMaxTokens
    };

    const attempts = [];
    if (this.disableThinking) {
      attempts.push({
        ...basePayload,
        enable_thinking: false,
        extra_body: {
          enable_thinking: false
        }
      });
    }
    attempts.push(basePayload);

    for (let i = 0; i < attempts.length; i += 1) {
      const payload = attempts[i];
      const resp = await this.doChatRequest(payload);

      if (resp.ok) {
        const content = toTextContent(resp?.data?.choices?.[0]?.message?.content);
        if (!content) {
          throw new Error('模型返回为空');
        }
        return content;
      }

      const messageText = `模型调用失败: ${resp.status} ${resp.errorText || ''}`.trim();
      const hasNext = i < attempts.length - 1;
      if (hasNext && this.disableThinking && this.shouldRetryWithoutThinking(resp.errorText)) {
        continue;
      }
      throw new Error(messageText);
    }

    throw new Error('模型调用失败：未知错误');
  }

  async extractTextFromImage(imagePath) {
    if (this.mockMode) {
      return `[MOCK_IMAGE_TEXT] ${path.basename(imagePath)} 教材内容示例：本章节介绍一次函数与图像变换。`;
    }

    const file = await fs.readFile(imagePath);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    const b64 = file.toString('base64');

    const prompts = ['请把这张教材图片完整转写为中文文本。', '请提取图片中的主要文字，按行输出。'];
    let lastErr = null;
    for (const ask of prompts) {
      try {
        const text = await this.chatCompletion({
          messages: [
            {
              role: 'system',
              content: '你是一个严谨的图片转写助手，只输出图片中可见文本，不要自行补充。'
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: ask },
                { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
              ]
            }
          ],
          temperature: 0.1
        });
        if (text?.trim()) {
          return text;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`图片转写失败: ${lastErr?.message || '模型未返回内容'}`);
  }

  async generateOutline(payload) {
    const mergedText = typeof payload === 'string' ? payload : payload?.mergedText || '';
    const request = typeof payload === 'string' ? '' : payload?.request || '';
    const requestedPageCount = parseRequestedPageCount(request, null);

    if (this.mockMode) {
      const pages = requestedPageCount || 3;
      return {
        title: '教材自动生成课件',
        pages: [
          {
            title: '课程目标',
            bullet_points: ['理解一次函数概念', '掌握图像与斜率关系', '完成课堂练习'],
            notes: '可结合教材第一页定义部分展开。'
          },
          {
            title: '核心知识点',
            bullet_points: ['函数表达式 y = kx + b', 'k 决定增减性', 'b 决定与 y 轴交点'],
            notes: '演示图像平移示例。'
          },
          {
            title: '课堂练习与总结',
            bullet_points: ['例题讲解', '分层练习', '当堂小测'],
            notes: '最后 5 分钟回顾常见错误。'
          },
          {
            title: '教学建议',
            bullet_points: ['按层次提问', '分组活动', '板书结构化'],
            notes: '根据班级水平灵活调整任务难度。'
          }
        ].slice(0, pages)
      };
    }

    const pageRule = requestedPageCount
      ? `3. 页面数固定为 ${requestedPageCount} 页。`
      : '3. 页面数 8-12 页。';

    const prompt = `请根据以下教材转写文本和用户需求，输出 PPT 大纲 JSON。
要求：
1. 仅输出 JSON，不要其他解释。
2. 结构必须是 {"title": string, "pages": [{"title": string, "bullet_points": string[], "notes": string}]}
${pageRule}
4. 内容面向中国老师课堂授课。
5. 必须贴合用户要求的页数、风格、对象与教学目标。

用户需求：${String(request || '请基于教材图片生成教师授课PPT')}
教材文本：\n${mergedText}`;

    const parseOutlineFromOutput = (output) => {
      const candidates = [];
      const first = parseJsonBlock(output);
      if (first) {
        candidates.push(first);
      }

      for (const block of extractCodeBlocks(output)) {
        const parsed = parseJsonMaybe(block);
        if (parsed) {
          candidates.push(parsed);
        }
      }

      for (const chunk of extractBalancedObjects(output)) {
        const parsed = parseJsonMaybe(chunk);
        if (parsed) {
          candidates.push(parsed);
        }
      }

      for (const candidate of candidates) {
        const normalized = normalizeOutlineObject(candidate);
        if (normalized && normalized.pages.length) {
          if (requestedPageCount && normalized.pages.length !== requestedPageCount) {
            if (normalized.pages.length > requestedPageCount) {
              normalized.pages = normalized.pages.slice(0, requestedPageCount);
            } else {
              while (normalized.pages.length < requestedPageCount) {
                const idx = normalized.pages.length + 1;
                normalized.pages.push({
                  title: `第 ${idx} 页`,
                  bullet_points: ['补充教学要点', '补充课堂活动设计', '补充讲解提示'],
                  notes: '根据教材内容补足本页信息。',
                });
              }
            }
          }
          return normalized;
        }
      }
      return null;
    };

    let content = '';
    let outline = null;
    try {
      content = await this.chatCompletion({
        messages: [
          {
            role: 'system',
            content: '你是一个课程设计助手，输出严格 JSON。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2
      });
      outline = parseOutlineFromOutput(content);
    } catch {
      outline = null;
    }
    if (outline) {
      return outline;
    }

    try {
      const repaired = await this.chatCompletion({
        messages: [
          {
            role: 'system',
            content:
              '你是 JSON 修复助手。把用户给出的内容转成合法 JSON，且仅输出 JSON，不要任何解释。输出结构必须为 {"title": string, "pages": [{"title": string, "bullet_points": string[], "notes": string}]}。'
          },
          {
            role: 'user',
            content: `请修复为合法 JSON：\n${String(content || '').slice(0, 12000)}`
          }
        ],
        temperature: 0
      });
      outline = parseOutlineFromOutput(repaired);
      if (outline) {
        return outline;
      }
    } catch {
      // 忽略修复失败，进入本地兜底大纲。
    }

    return buildFallbackOutlineFromText(mergedText, requestedPageCount);
  }

  async generatePptReasoning({ request = '', mergedText = '', outline = null }) {
    const fallback = buildPptReasoningFallback({ request, mergedText, outline });
    if (this.mockMode) {
      return fallback;
    }

    const contentPreview = String(mergedText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 24)
      .join('\n');

    const outlineJson = JSON.stringify(outline || {}, null, 2).slice(0, 8000);
    const prompt = `你要输出“可展示给用户的PPT生成推理摘要”，请仿照以下结构输出，使用简洁中文、markdown格式。
结构要求：
1) 用户意图拆解
2) 图片文本关键信息
3) 受众与教学目标判断
4) 页面结构方案（按页列出）
5) 内容草稿策略
6) 质量检查与兜底策略

限制：
- 只输出可展示摘要，不要输出“我不能透露推理过程”这类措辞。
- 控制在 12-28 行。
- 必须对齐用户需求（尤其是页数、风格和受众）。

用户需求：${String(request || '根据教材图片生成教师授课PPT')}
图片转写摘要：
${contentPreview}

已生成大纲JSON：
${outlineJson}`;

    try {
      const out = await this.chatCompletion({
        messages: [
          {
            role: 'system',
            content: '你是教学PPT方案顾问，擅长把意图拆解为清晰可执行的页面规划。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
      });
      const text = String(out || '').trim();
      return text || fallback;
    } catch {
      return fallback;
    }
  }

  async generateOutlineWithReasoning({ mergedText, request = '' }) {
    const outline = await this.generateOutline({ mergedText, request });
    const reasoning = await this.generatePptReasoning({ request, mergedText, outline });
    return { outline, reasoning };
  }

  async generateGeneralReply({ message, history = [], hasOnlineDevice = false, allowedRoot = '' }) {
    if (this.mockMode) {
      return `已收到：${message}\n这是 mock 模式下的通用回复。你可以上传教材图生成 PPT，或上传成绩表进行分析。`;
    }

    const trimmedHistory = history
      .filter((item) => item && ['user', 'assistant'].includes(item.role) && item.content)
      .slice(-10)
      .map((item) => ({ role: item.role, content: String(item.content) }));

    return this.chatCompletion({
      messages: [
        {
          role: 'system',
          content: `你是面向中国老师的 AI 教学助手。请用简洁中文回答，并直接回应用户刚刚那句话。
回答控制在 1-5 句，先回答问题本身，再给必要下一步。
遇到 PPT/成绩分析/英语作文批改需求时，提醒用户可上传附件继续。
若用户是本地文件相关问题，且本地设备在线，请不要说“无法访问本地文件”；应明确说明可在授权目录内读写，并给出一句示例指令。
当前本地设备状态：${hasOnlineDevice ? `在线（授权目录：${allowedRoot || '已配置'}）` : '离线或未连接'}。
你不应臆测模型厂商或训练方，不要自称 Google/OpenAI/Anthropic 等。
若用户问“你是什么模型”，请明确回答：当前服务端配置模型为 ${this.model}（通过阿里云接口调用）。
严禁使用固定模板话术（如“老师您好”“收到您的输入…”“建议下一步如下”）。
若用户输入很短（如“111”），先判断其可能意图并给一句简短追问，不输出长清单。`
        },
        ...trimmedHistory,
        { role: 'user', content: String(message || '') }
      ],
      temperature: 0.4
    });
  }

  async analyzeGradesFromContext({ request, gradeText, history = [] }) {
    if (this.mockMode) {
      return `已基于当前会话中的成绩数据完成分析：${String(request || '').trim() || '请继续说明要分析的学生或科目。'}`;
    }

    const trimmedHistory = history
      .filter((item) => item && ['user', 'assistant'].includes(item.role) && item.content)
      .slice(-8)
      .map((item) => ({ role: item.role, content: String(item.content) }));

    const text = String(gradeText || '').trim();
    const clipped = text.length > 12000 ? `${text.slice(0, 12000)}\n...(成绩文本过长，已截断)` : text;

    return this.chatCompletion({
      messages: [
        {
          role: 'system',
          content: `你是成绩分析助手。用户当前会话里已经提供了成绩文本数据。
要求：
1) 直接基于给定文本分析，不要让用户重复上传文件。
2) 先回答用户当前问题本身，再给简短结论。
3) 若用户点名了学生/科目/月份，必须优先围绕这些维度分析。
4) 若数据字段不足，明确说明缺失项与可行补充方式，但不要输出模板化长清单。
5) 中文简洁输出，控制在 4-10 句。`
        },
        ...trimmedHistory,
        {
          role: 'user',
          content: `用户请求：${String(request || '').trim()}\n\n可用成绩文本：\n${clipped}`
        }
      ],
      temperature: 0.2
    });
  }

  async reviewEssayFromImages({ imagePaths = [], topic = '', request = '' }) {
    if (this.mockMode) {
      return {
        transcription: 'This is a mock essay text.',
        requirement_summary: ['标题需要写出最喜欢的菜名', '正文要说明喜欢这道菜的原因或故事', '需要写 ingredients 和制作步骤'],
        requirement_mismatches: ['制作步骤不够完整', '语言错误会影响语法与拼写项得分'],
        scoring_breakdown: [
          { criterion: '标题包含菜名', max_score: 1, awarded_score: 1, reason: '标题已写出菜名。' },
          { criterion: '内容完整度', max_score: 3, awarded_score: 2, reason: '原因和回忆有涉及，但表达不够清晰。' },
        ],
        estimated_score: 9,
        full_score: 12,
        score_reason: '内容基本切题，但步骤表达和语言准确性仍有扣分。',
        topic_match_score: topic ? 4 : null,
        topic_match_reason: topic ? '内容基本围绕给定主题展开，但细节支撑还不够充分。' : '未提供主题，暂不评分。',
        spelling_errors: [{ original: 'becuse', suggestion: 'because', reason: '常见拼写错误。' }],
        grammar_issues: [{ original: 'She go to school yesterday.', suggestion: 'She went to school yesterday.', reason: '时态错误。' }],
        overall_feedback: '整体表达基本清楚，建议继续检查时态与拼写细节。',
      };
    }

    const safePaths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean).slice(0, 6) : [];
    if (!safePaths.length) {
      throw new Error('缺少作文图片');
    }

    const parseReviewFromOutput = (output) => {
      const candidates = [];
      const first = parseJsonBlock(output);
      if (first) {
        candidates.push(first);
      }
      for (const block of extractCodeBlocks(output)) {
        const parsed = parseJsonMaybe(block);
        if (parsed) {
          candidates.push(parsed);
        }
      }
      for (const chunk of extractBalancedObjects(output)) {
        const parsed = parseJsonMaybe(chunk);
        if (parsed) {
          candidates.push(parsed);
        }
      }
      for (const candidate of candidates) {
        const normalized = normalizeEssayReview(candidate);
        if (normalized) {
          return normalized;
        }
      }
      return null;
    };

    const directPrompt = [
      '请读取这些英语作文图片。若图片里同时包含作文题目要求、评分点和学生作文，请先抽取要求，再按要求客观评分。输出严格 JSON，不要输出 markdown 或额外解释。',
      'JSON 结构必须为：',
      '{',
      '  "transcription": "完整英文作文转写文本",',
      '  "requirement_summary": ["作文要求1", "作文要求2"],',
      '  "requirement_mismatches": ["当前作文与要求不一致或缺失的点"],',
      '  "scoring_breakdown": [{"criterion":"评分项","max_score":1,"awarded_score":1,"reason":"给分说明"}],',
      '  "estimated_score": 数字或 null,',
      '  "full_score": 数字或 null,',
      '  "score_reason": "总分说明",',
      '  "topic_match_score": 1-5 或 null,',
      '  "topic_match_reason": "一句话说明",',
      '  "spelling_errors": [{"original":"错词","suggestion":"正确写法","reason":"原因"}],',
      '  "grammar_issues": [{"original":"原句/片段","suggestion":"修改建议","reason":"原因"}],',
      '  "overall_feedback": "整体反馈"',
      '}',
      '要求：',
      '1. 若图片中存在任务说明、评分点或分值，必须优先按这些要求评分，并提取到 requirement_summary / scoring_breakdown。',
      '2. requirement_mismatches 要指出当前作文与要求相比缺了什么、做错了什么、哪里没覆盖到。',
      '3. 只检查明显的拼写错误和病句/语法问题，不要把正常表达误判为错误。',
      '4. estimated_score / full_score 要尽量客观；如果图中没有足够评分依据，可为 null。',
      '5. 若未提供额外主题，则 topic_match_score 可以为 null；若图片里的题目本身足以判断是否切题，也可以据此给分。',
      '6. overall_feedback 用简洁中文。',
      `当前用户要求：${String(request || '').trim() || '检查英语作文病句、拼写、与题目要求的差异，并客观打分'}`,
      `当前主题：${topic ? topic : '未提供'}`,
    ].join('\n');

    try {
      const content = [{ type: 'text', text: directPrompt }];
      for (const imagePath of safePaths) {
        const file = await fs.readFile(imagePath);
        const ext = path.extname(imagePath).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        content.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${file.toString('base64')}` },
        });
      }

      const output = await this.chatCompletion({
        messages: [
          {
            role: 'system',
            content: '你是英语作文批改助手。必须严格输出 JSON。',
          },
          {
            role: 'user',
            content,
          },
        ],
        temperature: 0.1,
      });

      const review = parseReviewFromOutput(output);
      if (review) {
        return review;
      }
    } catch {
      // fall through to OCR + text analysis
    }

    const transcriptions = [];
    for (const imagePath of safePaths) {
      transcriptions.push(await this.extractTextFromImage(imagePath));
    }
    const essayText = transcriptions.join('\n\n').trim();
    if (!essayText) {
      throw new Error('图片中未提取到可分析的作文文本');
    }

    const textPrompt = `请基于以下英语作文文本做批改，并只输出严格 JSON。
JSON 结构：
{
  "transcription": "完整英文作文转写文本",
  "requirement_summary": ["作文要求1", "作文要求2"],
  "requirement_mismatches": ["当前作文与要求不一致或缺失的点"],
  "scoring_breakdown": [{"criterion":"评分项","max_score":1,"awarded_score":1,"reason":"给分说明"}],
  "estimated_score": 数字或 null,
  "full_score": 数字或 null,
  "score_reason": "总分说明",
  "topic_match_score": 1-5 或 null,
  "topic_match_reason": "一句话说明",
  "spelling_errors": [{"original":"错词","suggestion":"正确写法","reason":"原因"}],
  "grammar_issues": [{"original":"原句/片段","suggestion":"修改建议","reason":"原因"}],
  "overall_feedback": "整体反馈"
}

要求：
1. 仅输出 JSON。
2. 如果当前文本中能识别出作文要求/评分点，请生成 requirement_summary、scoring_breakdown、estimated_score、full_score。
3. requirement_mismatches 要明确指出和要求相比缺失或不达标的点。
4. 若未提供主题且文本里也无法判断主题，则 topic_match_score=null。
5. 拼写和病句分别列出，若没有错误则返回空数组。
6. 不要编造图片中不存在的内容。

用户要求：${String(request || '').trim() || '检查英语作文病句、拼写、与题目要求的差异，并客观打分'}
当前主题：${topic ? topic : '未提供'}

作文文本：
${essayText}`;

    const output = await this.chatCompletion({
      messages: [
        {
          role: 'system',
          content: '你是英语作文批改助手。必须严格输出 JSON。',
        },
        {
          role: 'user',
          content: textPrompt,
        },
      ],
      temperature: 0.1,
    });

    const review = parseReviewFromOutput(output);
    if (!review) {
      throw new Error('模型未返回合法作文批改 JSON');
    }
    if (!review.transcription) {
      review.transcription = essayText;
    }
    return review;
  }

  async planMainAction({ message, history = [], hasOnlineDevice = false }) {
    if (this.mockMode) {
      return null;
    }

    const trimmedHistory = history
      .filter((item) => item && ['user', 'assistant'].includes(item.role) && item.content)
      .slice(-8)
      .map((item) => ({ role: item.role, content: String(item.content) }));

    const prompt = `请做“意图路由 + 动作规划”，只输出 JSON，不要 markdown。
可选 intent: "ppt" | "grades" | "essay_review" | "local_file" | "weather" | "chat"
可选 device_action: null | "list_dir" | "read_file" | "write_file" | "apply_patch" | "delete_path"

输出结构：
{
  "intent": "...",
  "device_action": null or "...",
  "device_payload": {},
  "weather_city": null or "城市名",
  "weather_write_path": null or "文件路径",
  "essay_topic": null or "作文主题",
  "reason": "一句话解释"
}

规则：
0) 你是在做“语义动作规划”，不是关键词分类。要先理解用户想完成什么，再决定 intent 和 device_action。
1) 若用户要看本地目录/文件内容、写文件、改文件、删文件，intent=local_file。
2) 对 local_file：
   - “目录里有什么/列出文件” -> list_dir，payload 至少含 path（缺省 "."）
   - “读取/打开文件” -> read_file，payload 要有 path
   - “写入/覆盖/追加/创建文本/生成文档/帮我记下来” -> write_file，payload 要有 path/content，追加时 append=true
   - 若用户只用自然语言描述“生成一个文本，里面包含……”但没给文件名，你应主动补一个合理默认文件名：
     文本默认 "新建文本.txt"，文档默认 "新建文档.md"，表格/清单默认 "新建表格.csv"
   - 若用户说“里面包含… / 内容是… / 写上… / 记下…”，应把后续文本提取进 content，而不是回到 chat
   - 提供 patch/diff -> apply_patch，payload 要有 path/patch
   - “删除文件/删除目录” -> delete_path，payload 要有 path；若删除目录可带 recursive=true
   - 即使用户没有说“文件”“写入”这些字样，只要语义上是在让系统把某段内容记下来、落盘、生成成本地文本，也应规划为 write_file
3) 若用户要生成课件/PPT -> intent=ppt。
4) 若用户要检查英语作文图片中的病句、语法、拼写、主题匹配度 -> intent=essay_review，并尽量提取 essay_topic。
5) 若用户要成绩统计分析 -> intent=grades。
6) 若用户要查天气（例如“深圳未来一周天气”），intent=weather，并尽量提取 weather_city。
7) 若用户还要求“写入/保存到某文件”，weather_write_path 填路径（可相对路径）。
8) 其余普通问答 -> intent=chat。
9) 当前设备在线状态：${hasOnlineDevice ? '有在线设备' : '无在线设备'}（这只影响你规划，不改变 intent）。

用户消息：
${String(message || '')}`;

    const content = await this.chatCompletion({
      messages: [
        {
          role: 'system',
          content: '你是严格 JSON 路由器，绝不输出 JSON 以外的内容。'
        },
        ...trimmedHistory,
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0
    });

    const parsed = parseJsonBlock(content);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const intent = String(parsed.intent || '').trim();
    const validIntents = new Set(['ppt', 'grades', 'essay_review', 'local_file', 'weather', 'chat']);
    if (!validIntents.has(intent)) {
      return null;
    }

    const deviceActionRaw = parsed.device_action == null ? null : String(parsed.device_action).trim();
    const validActions = new Set(['list_dir', 'read_file', 'write_file', 'apply_patch', 'delete_path']);
    const deviceAction = deviceActionRaw && validActions.has(deviceActionRaw) ? deviceActionRaw : null;

    const devicePayload =
      parsed.device_payload && typeof parsed.device_payload === 'object' ? parsed.device_payload : {};

    return {
      intent,
      device_action: deviceAction,
      device_payload: devicePayload,
      weather_city: parsed.weather_city ? String(parsed.weather_city).trim() : null,
      weather_write_path: parsed.weather_write_path ? String(parsed.weather_write_path).trim() : null,
      essay_topic: parsed.essay_topic ? String(parsed.essay_topic).trim() : null,
      reason: parsed.reason ? String(parsed.reason) : null
    };
  }
}
