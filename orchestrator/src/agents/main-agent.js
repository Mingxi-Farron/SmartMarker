import XLSX from 'xlsx';

export class MainAgent {
  constructor({ db, modelClient, hub, weatherService }) {
    this.db = db;
    this.modelClient = modelClient;
    this.hub = hub;
    this.weatherService = weatherService;
  }

  inferIntent(message) {
    const text = String(message || '').toLowerCase();
    if (/(作文|essay|英文作文|英语作文|病句|语法错误?|拼写错误?|拼写|语法|主题匹配|是否match|match|topic|theme|跑题)/.test(text)) {
      return 'essay_review';
    }
    if (/天气|气温|降雨|未来.?周|未来.?天/.test(text)) {
      return 'weather';
    }
    if (/ppt|课件|幻灯|投影片/.test(text)) {
      return 'ppt';
    }
    if (/(成绩|分数|成绩单|平均分|排名|及格率|班级统计|月考|期中|期末|csv|xlsx|xls)/.test(text)) {
      return 'grades';
    }
    if (
      /(read_file|write_file|apply_patch|list_dir|delete_path|\[dir\]|本地目录|本地文件|授权目录|读取.*文件|打开.*文件|查看.*文件|写入.*文件|创建.*文件|新建.*文件|生成.*文件|新增.*文件|修改.*文件|编辑.*文件|删除.*文件|删掉.*文件|移除.*文件|创建.*文本|生成.*文本|新建.*文本|记下来|记下.*文件|记录到.*文件|写到.*文件|补丁|patch|diff)/.test(
        text,
      )
    ) {
      return 'local_file';
    }
    return 'chat';
  }

  withSession(payload, sessionId) {
    return { ...payload, session_id: sessionId };
  }

  pickOnlineDevice(userId, preferredDeviceId = null) {
    const devices = this.db.listUserDevices(userId);
    if (!devices.length) {
      return { device: null, reason: 'no_device' };
    }
    const preferredId = preferredDeviceId ? String(preferredDeviceId) : '';
    const preferredOnline = preferredId
      ? devices.find((d) => d.id === preferredId && this.hub?.isOnline(d.id))
      : null;
    if (preferredOnline) {
      return { device: preferredOnline, reason: null, preferred: true };
    }

    const online = devices.find((d) => this.hub?.isOnline(d.id));
    if (!online) {
      return { device: null, reason: 'offline', devices };
    }
    return { device: online, reason: null };
  }

  sanitizePathToken(token) {
    return String(token || '')
      .trim()
      .replace(/^[:：]/, '')
      .replace(/[，。；,;.!！?？]+$/g, '')
      .trim();
  }

  extractPath(text) {
    const str = String(text || '');
    const dirTag = str.match(/\[DIR\]\s*([^\s，。；,;]+)/i);
    if (dirTag?.[1]) {
      return this.sanitizePathToken(dirTag[1]);
    }

    const quoted =
      str.match(/`([^`]+)`/) ||
      str.match(/"([^"]+)"/) ||
      str.match(/'([^']+)'/) ||
      str.match(/“([^”]+)”/) ||
      str.match(/‘([^’]+)’/);
    if (quoted?.[1]) {
      return this.sanitizePathToken(quoted[1]);
    }

    const byLabel = str.match(/(?:路径|目录|文件)\s*[:：]\s*([^\s，。；,;]+)/);
    if (byLabel?.[1]) {
      return this.sanitizePathToken(byLabel[1]);
    }

    const byName = str.match(/(?:叫|命名为|文件名(?:是|为)?|名称(?:是|为)?)\s*[:：]?\s*([^\s，。；,;`"'“”‘’]+)/i);
    if (byName?.[1]) {
      return this.sanitizePathToken(byName[1]);
    }

    const abs = str.match(/(^|\s)(\/[^\s，。；,;]+)/);
    if (abs?.[2]) {
      return this.sanitizePathToken(abs[2]);
    }

    const rel = str.match(/(^|\s)((?:\.{1,2}\/)?[^\s，。；,;]*\/[^\s，。；,;]+)/);
    if (rel?.[2]) {
      return this.sanitizePathToken(rel[2]);
    }

    return null;
  }

  extractPatch(text) {
    const m = String(text || '').match(/```(?:patch|diff)\s*([\s\S]*?)```/i);
    return m?.[1]?.trim() || null;
  }

  extractContent(text) {
    const str = String(text || '');
    const code = str.match(/```(?:text|txt|md|json|csv)?\s*([\s\S]*?)```/i);
    if (code?.[1] && !/^(patch|diff)\b/i.test((code[0] || '').replace(/```/g, '').trim())) {
      return code[1];
    }

    const byLabel = str.match(/(?:内容|content|正文)\s*[:：]\s*([\s\S]+)$/i);
    if (byLabel?.[1]) {
      return byLabel[1];
    }
    return null;
  }

  extractImplicitWriteContent(text) {
    const str = String(text || '').trim();
    if (!str) {
      return null;
    }

    const patterns = [
      /(?:里面包含|包含内容|内容包含|写上|写入|内容是|内容为|正文是|正文为|文本内容是|文本内容为)\s*[:：，,]?\s*([\s\S]+)$/i,
      /(?:生成|创建|新建).{0,16}?(?:文本|文档|文件).{0,8}?(?:内容|里面)\s*[:：，,]?\s*([\s\S]+)$/i,
      /(?:(?:帮我)?记下来|(?:帮我)?记下|记录下)\s*[:：，,]?\s*([\s\S]+)$/i,
      /(?:记录|记到|写到).{0,12}?(?:文件|文本|文档)?\s*[:：，,]?\s*([\s\S]+)$/i,
    ];

    for (const pattern of patterns) {
      const hit = str.match(pattern);
      const raw = String(hit?.[1] || '').trim();
      if (!raw) {
        continue;
      }
      return raw.replace(/^[“"'`‘’]+|[”"'`‘’]+$/g, '').trim();
    }

    return null;
  }

  inferDefaultWritePath(text) {
    const str = String(text || '');
    const explicitName = str.match(/([A-Za-z0-9_\-\u4e00-\u9fa5][A-Za-z0-9_\-\u4e00-\u9fa5 ]{0,80}\.(?:txt|md|csv|json))/i);
    if (explicitName?.[1]) {
      return this.sanitizePathToken(explicitName[1]);
    }

    if (!/(创建|新建|生成|新增|写入|保存|记录|记下|记到|写个|做个)/i.test(str)) {
      return null;
    }

    if (/\bcsv\b/i.test(str) || /表格|成绩单|清单/.test(str)) {
      return '新建表格.csv';
    }
    if (/\bjson\b/i.test(str)) {
      return '新建数据.json';
    }
    if (/(记录|记下|记下来|记到)/.test(str)) {
      return '新建文本.txt';
    }
    if (/\bmd\b/i.test(str) || /markdown|笔记|文档/.test(str)) {
      return '新建文档.md';
    }
    if (/文本|txt|文件/.test(str)) {
      return '新建文本.txt';
    }
    return null;
  }

  normalizePlannedLocalCommand(planned, message) {
    if (planned?.intent !== 'local_file' || !planned?.device_action) {
      return null;
    }

    const action = String(planned.device_action || '').trim();
    const payload = planned?.device_payload && typeof planned.device_payload === 'object'
      ? { ...planned.device_payload }
      : {};
    const text = String(message || '');

    if (action === 'list_dir') {
      return {
        action,
        payload: {
          ...payload,
          path: payload.path ? this.sanitizePathToken(payload.path) : this.extractPath(text) || '.',
        },
      };
    }

    if (action === 'read_file') {
      const path = payload.path ? this.sanitizePathToken(payload.path) : this.extractPath(text);
      if (!path) {
        return null;
      }
      return {
        action,
        payload: {
          ...payload,
          path,
        },
      };
    }

    if (action === 'write_file') {
      const path =
        payload.path ? this.sanitizePathToken(payload.path) : this.extractPath(text) || this.inferDefaultWritePath(text);
      const rawContent =
        typeof payload.content === 'string' && payload.content.trim()
          ? payload.content.trim()
          : this.extractContent(text) || this.extractImplicitWriteContent(text);
      if (!path || !rawContent) {
        return null;
      }
      return {
        action,
        payload: {
          ...payload,
          path,
          content: rawContent,
          append: Boolean(payload.append) || /(追加|append)/i.test(text),
        },
      };
    }

    if (action === 'apply_patch') {
      const path = payload.path ? this.sanitizePathToken(payload.path) : this.extractPath(text);
      const patch = typeof payload.patch === 'string' && payload.patch.trim() ? payload.patch.trim() : this.extractPatch(text);
      if (!path || !patch) {
        return null;
      }
      return {
        action,
        payload: {
          ...payload,
          path,
          patch,
        },
      };
    }

    if (action === 'delete_path') {
      const path = payload.path ? this.sanitizePathToken(payload.path) : this.extractPath(text);
      if (!path) {
        return null;
      }
      return {
        action,
        payload: {
          ...payload,
          path,
          recursive: Boolean(payload.recursive) || /(递归|整个目录|整个文件夹|目录及其内容|recursive)/i.test(text),
        },
      };
    }

    return null;
  }

  isCapabilityQuestion(text) {
    const t = String(text || '');
    const ask = /(为什么|能不能|可以吗|可不可以|能否|是否|是不是|有没有权限|有权限吗)/.test(t);
    const aboutLocal = /(本地|文件|目录|授权目录|访问|修改|写入|读取|删除)/.test(t);
    const hasActionHint = /(读取|打开|列出|查看|写入|创建|新建|生成.*文件|修改.*文件|删除.*文件|删掉.*文件|apply_patch|write_file|read_file|list_dir|delete_path)/.test(
      t,
    );
    return ask && aboutLocal && !hasActionHint;
  }

  sanitizeCityName(name) {
    return String(name || '')
      .trim()
      .replace(/[，。；,;.!！?？]+$/g, '')
      .replace(/^中国/, '')
      .replace(/(省|市|自治区|特别行政区)$/g, '')
      .trim();
  }

  extractWeatherCity(message, plannedCity = null) {
    if (plannedCity) {
      const normalized = this.sanitizeCityName(plannedCity);
      if (normalized) {
        return normalized;
      }
    }

    const text = String(message || '');
    const byKeyword =
      text.match(/(?:查|查询|看|看看|帮我查|帮我看)?\s*([A-Za-z\u4e00-\u9fa5]{2,20}?)(?:未来.?周|未来.?天|这周|本周|下周|一周|7天|七天|天气|气温)/) ||
      text.match(/([A-Za-z\u4e00-\u9fa5]{2,20}?)(?:天气|气温)/);

    const raw = byKeyword?.[1] || '';
    const city = this.sanitizeCityName(raw);
    if (!city || /(今天|明天|后天|未来|本周|下周|天气|气温|帮我|查下|一下)/.test(city)) {
      return null;
    }
    return city;
  }

  extractWeatherWritePath(message, plannedPath = null) {
    if (plannedPath) {
      return this.sanitizePathToken(plannedPath);
    }

    const text = String(message || '');
    const byVerb = text.match(
      /(?:写到|写入|保存到|存到|写进)\s*(?:文件)?\s*[:：]?\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)'|“([^”]+)”|([^\s，。；,;]+))/i,
    );
    const value = byVerb?.[1] || byVerb?.[2] || byVerb?.[3] || byVerb?.[4] || byVerb?.[5];
    if (value) {
      return this.sanitizePathToken(value);
    }

    const txtName = text.match(/([^\s，。；,;`"'“”‘’]+\.txt)\b/i);
    if (txtName?.[1]) {
      return this.sanitizePathToken(txtName[1]);
    }
    return null;
  }

  isShortProbeInput(message) {
    const text = String(message || '').trim();
    if (!text) {
      return false;
    }
    if (text.length <= 4 && /^[\d\s]+$/.test(text)) {
      return true;
    }
    return text.length <= 3 && /^[a-zA-Z]+$/.test(text);
  }

  extractGradeFileHint(message) {
    const fromPath = this.extractPath(message);
    if (fromPath && /\.(csv|xlsx|xls|txt|md)$/i.test(fromPath)) {
      return fromPath;
    }
    const quoted =
      String(message || '').match(/`([^`]+\.(?:csv|xlsx|xls|txt|md))`/i) ||
      String(message || '').match(/"([^"]+\.(?:csv|xlsx|xls|txt|md))"/i) ||
      String(message || '').match(/'([^']+\.(?:csv|xlsx|xls|txt|md))'/i) ||
      String(message || '').match(/“([^”]+\.(?:csv|xlsx|xls|txt|md))”/i);
    if (quoted?.[1]) {
      return this.sanitizePathToken(quoted[1]);
    }
    const byName = String(message || '').match(/([A-Za-z0-9_\-\u4e00-\u9fa5][A-Za-z0-9_\-\u4e00-\u9fa5 ]{0,80}\.(?:csv|xlsx|xls|txt|md))/i);
    if (!byName?.[1]) {
      return null;
    }
    return this.sanitizePathToken(
      String(byName[1]).replace(/^(现在在|先在|在|基于|根据|用|使用|查看|看一下|分析|帮我|请|按|对)\s*/i, ''),
    );
  }

  extractStudentScoreUpdate(message) {
    const text = String(message || '');
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    if (!/(加|新增|添加|补充|加入|更新|修改)/.test(trimmed) || !/(学生|成绩)/.test(trimmed)) {
      return null;
    }

    const nameMatch =
      trimmed.match(/(?:名字叫|姓名叫|学生叫|名字是|姓名是|学生是)\s*([A-Za-z][A-Za-z0-9_-]{1,31}|[\u4e00-\u9fa5]{2,16})/i) ||
      trimmed.match(/新增(?:一个)?学生\s*([A-Za-z][A-Za-z0-9_-]{1,31}|[\u4e00-\u9fa5]{2,16})/i);
    const student = String(nameMatch?.[1] || '').trim();
    if (!student) {
      return null;
    }

    const subjectScores = {};
    const assignIfFinite = (key, value) => {
      const score = Number(value);
      if (Number.isFinite(score)) {
        subjectScores[key] = score;
      }
    };

    for (const hit of trimmed.matchAll(/(语文|数学|英语|总分|Chinese|Math|English)\s*(?:成绩)?\s*(?:是|为|:|：)?\s*(\d{1,3}(?:\.\d+)?)/gi)) {
      const subject = String(hit[1] || '').trim();
      assignIfFinite(subject, hit[2]);
    }

    const triad = trimmed.match(/语数英(?:成绩)?\s*(?:是|为|:|：)?\s*(\d{1,3}(?:\.\d+)?)\s+[，,\s]*(\d{1,3}(?:\.\d+)?)\s+[，,\s]*(\d{1,3}(?:\.\d+)?)/i);
    if (triad) {
      assignIfFinite('语文', triad[1]);
      assignIfFinite('数学', triad[2]);
      assignIfFinite('英语', triad[3]);
    }

    if (!Object.keys(subjectScores).length) {
      return null;
    }

    return { student, subjectScores };
  }

  isExcelGradeMutationRequest(message) {
    const filePath = this.extractGradeFileHint(message);
    if (!filePath || !/\.(xlsx|xls)$/i.test(filePath)) {
      return false;
    }
    return Boolean(this.extractStudentScoreUpdate(message));
  }

  excelColumnName(headers, patterns, fallbackLabel) {
    const list = Array.isArray(headers) ? headers : [];
    const found = list.find((item) => patterns.some((pattern) => pattern.test(String(item || ''))));
    return found || fallbackLabel;
  }

  async upsertStudentScoresInExcel({ userId, deviceId, filePath, studentUpdate }) {
    const executed = await this.hub.request({
      userId,
      deviceId,
      action: 'read_file',
      payload: {
        path: filePath,
        encoding: 'base64',
      },
    });
    const base64 = String(executed?.result?.content || '').trim();
    if (!base64) {
      throw new Error('Excel 文件内容为空');
    }

    const bookType = /\.xls$/i.test(String(filePath || '')) ? 'xls' : 'xlsx';
    const workbook = XLSX.read(Buffer.from(base64, 'base64'), { type: 'buffer' });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      throw new Error('Excel 中没有可用工作表');
    }

    const sheet = workbook.Sheets[firstSheet];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const headers = Array.from(
      new Set([
        ...Object.keys(rows[0] || {}),
        ...Object.keys(rows.find((row) => row && typeof row === 'object') || {}),
      ]),
    );

    const nameKey = this.excelColumnName(headers, [/(姓名|学生|name|student)/i], '姓名');
    const chineseKey = this.excelColumnName(headers, [/(语文|chinese)/i], '语文');
    const mathKey = this.excelColumnName(headers, [/(数学|math)/i], '数学');
    const englishKey = this.excelColumnName(headers, [/(英语|english)/i], '英语');

    const nextHeaders = [...headers];
    for (const key of [nameKey, chineseKey, mathKey, englishKey]) {
      if (!nextHeaders.includes(key)) {
        nextHeaders.push(key);
      }
    }

    let target = rows.find((row) => String(row?.[nameKey] || '').trim().toLowerCase() === studentUpdate.student.toLowerCase());
    const created = !target;
    if (!target) {
      target = {};
      rows.push(target);
    }

    target[nameKey] = studentUpdate.student;
    if (studentUpdate.subjectScores['语文'] != null) {
      target[chineseKey] = studentUpdate.subjectScores['语文'];
    }
    if (studentUpdate.subjectScores['数学'] != null) {
      target[mathKey] = studentUpdate.subjectScores['数学'];
    }
    if (studentUpdate.subjectScores['英语'] != null) {
      target[englishKey] = studentUpdate.subjectScores['英语'];
    }

    workbook.Sheets[firstSheet] = XLSX.utils.json_to_sheet(rows, { header: nextHeaders });
    const nextBuffer = XLSX.write(workbook, { type: 'buffer', bookType });

    const writeResult = await this.hub.request({
      userId,
      deviceId,
      action: 'write_file',
      payload: {
        path: filePath,
        encoding: 'base64',
        content: nextBuffer.toString('base64'),
        append: false,
      },
    });

    return {
      created,
      path: writeResult?.result?.path || filePath,
      sheetName: firstSheet,
    };
  }

  unwrapFileStyleContent(content) {
    const text = String(content || '').trim();
    if (!text) {
      return null;
    }

    let payload = text;
    const fileStyle = text.match(/^文件[:：][^\n]*\n\s*\n([\s\S]+)$/);
    if (fileStyle?.[1]) {
      payload = fileStyle[1].trim();
    }
    return payload;
  }

  extractGradeTextBlock(content) {
    const payload = this.unwrapFileStyleContent(content);
    if (!payload) {
      return null;
    }

    const lines = payload.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) {
      return null;
    }

    const separatedRows = lines.filter((line) => /,|，|\t/.test(line)).length;
    const numberCount = (payload.match(/\d+(?:\.\d+)?/g) || []).length;
    const gradeSignals = /(学生|姓名|班级|月份|语文|数学|英语|成绩|分数|student|score|class|month)/i.test(payload);
    if (separatedRows < 2 || numberCount < 4 || !gradeSignals) {
      return null;
    }
    return payload;
  }

  parseCompactGradeEntries(content) {
    const payload = this.unwrapFileStyleContent(content);
    if (!payload) {
      return [];
    }

    const matches = [];
    const pattern =
      /([A-Za-z][A-Za-z0-9_-]{1,23}|[\u4e00-\u9fa5]{2,12})\s*(?:的)?\s*(语文|数学|英语|物理|化学|生物|历史|地理|政治|道法|科学|Chinese|Math|English|Physics|Chemistry|Biology|History|Geography|Politics|Science)?\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*分?/gi;
    for (const hit of payload.matchAll(pattern)) {
      const student = String(hit[1] || '').trim();
      const subject = String(hit[2] || '').trim() || '总分';
      const score = Number(hit[3]);
      if (!student || !Number.isFinite(score)) {
        continue;
      }
      matches.push({ student, subject, score, period: '' });
    }

    if (matches.length >= 2) {
      return matches;
    }
    return [];
  }

  extractGradeAnalysisText(content) {
    const table = this.extractGradeTextBlock(content);
    if (table) {
      return table;
    }
    const compact = this.parseCompactGradeEntries(content);
    if (compact.length) {
      return this.unwrapFileStyleContent(content);
    }
    return null;
  }

  findGradeContextFromHistory(history) {
    const list = Array.isArray(history) ? history : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const block = this.extractGradeAnalysisText(list[i]?.content);
      if (block) {
        return block;
      }
    }
    return null;
  }

  extractGradePathFromLine(text) {
    const lines = String(text || '').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      const tagged = trimmed.match(/^(?:已写入文件|文件)\s*[:：]\s*(.+)$/);
      if (tagged?.[1]) {
        const candidate = this.sanitizePathToken(String(tagged[1]).replace(/\s*[（(].*$/, ''));
        if (/\.(csv|xlsx|xls|txt|md)$/i.test(candidate)) {
          return candidate;
        }
      }
      const abs = trimmed.match(/(\/[^\n\r]*?\.(?:csv|xlsx|xls|txt|md))/i);
      if (abs?.[1]) {
        return this.sanitizePathToken(String(abs[1]).replace(/\s*[（(].*$/, ''));
      }
    }
    return null;
  }

  normalizeEssayTopic(topic) {
    return String(topic || '')
      .trim()
      .replace(/^[“"'`‘’]+|[”"'`‘’]+$/g, '')
      .replace(/[。；;!！?？]+$/g, '')
      .trim();
  }

  extractEssayTopic(message, history = [], plannedTopic = null) {
    const candidates = [];
    if (plannedTopic) {
      candidates.push(String(plannedTopic));
    }
    candidates.push(String(message || ''));
    for (let i = history.length - 1; i >= 0 && candidates.length < 8; i -= 1) {
      candidates.push(String(history[i]?.content || ''));
    }

    for (const text of candidates) {
      const direct =
        text.match(/(?:当前主题|作文主题|主题|题目|topic|theme)\s*(?:是|为|[:：])\s*[“"'`]?([^"”'`\n]{2,120})/i) ||
        text.match(/围绕\s*[“"'`]?([^"”'`\n]{2,120})\s*(?:这个)?(?:主题|题目)/i);
      const value = direct?.[1] ? this.normalizeEssayTopic(direct[1]) : '';
      if (value) {
        return value;
      }
    }
    return null;
  }

  findGradeFilePathFromHistory(history) {
    const list = Array.isArray(history) ? history : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const path = this.extractGradePathFromLine(list[i]?.content);
      if (path) {
        return path;
      }
    }
    return null;
  }

  async guessGradeFileFromDevice({ userId, deviceId }) {
    try {
      const listed = await this.hub.request({
        userId,
        deviceId,
        action: 'list_dir',
        payload: { path: '.', limit: 200 },
      });
      const items = Array.isArray(listed?.result?.items) ? listed.result.items : [];
      const files = items
        .filter((item) => item && item.type === 'file' && /\.(csv|xlsx|xls|txt|md)$/i.test(String(item.name || '')))
        .map((item) => String(item.name || ''));
      if (!files.length) {
        return null;
      }

      const withScore = (name) => {
        let score = 0;
        if (/成绩|分数|score|grade/i.test(name)) {
          score += 20;
        }
        if (/\.csv$/i.test(name)) {
          score += 8;
        }
        if (/\.(xlsx|xls)$/i.test(name)) {
          score += 10;
        }
        if (/\d{1,2}\s*年|\d{1,2}\s*月/.test(name)) {
          score += 4;
        }
        return score;
      };

      files.sort((a, b) => withScore(b) - withScore(a) || a.localeCompare(b));
      return files[0] || null;
    } catch {
      return null;
    }
  }

  async readGradeTextFromDeviceFile({ userId, deviceId, filePath }) {
    const ext = String(filePath || '').toLowerCase();

    if (/\.(xlsx|xls)$/i.test(ext)) {
      const executed = await this.hub.request({
        userId,
        deviceId,
        action: 'read_file',
        payload: {
          path: filePath,
          encoding: 'base64',
        },
      });
      const base64 = String(executed?.result?.content || '').trim();
      if (!base64) {
        return null;
      }
      const workbook = XLSX.read(Buffer.from(base64, 'base64'), { type: 'buffer' });
      const firstSheet = workbook.SheetNames[0];
      if (!firstSheet) {
        return null;
      }
      return XLSX.utils.sheet_to_csv(workbook.Sheets[firstSheet]);
    }

    const executed = await this.hub.request({
      userId,
      deviceId,
      action: 'read_file',
      payload: { path: filePath },
    });
    return String(executed?.result?.content || '');
  }

  detectTableDelimiter(line) {
    const str = String(line || '');
    const commas = (str.match(/,/g) || []).length;
    const cnCommas = (str.match(/，/g) || []).length;
    const tabs = (str.match(/\t/g) || []).length;
    if (tabs >= commas && tabs >= cnCommas && tabs > 0) {
      return '\t';
    }
    if (cnCommas > commas) {
      return '，';
    }
    return ',';
  }

  parseTableLine(line, delimiter) {
    const raw = String(line || '');
    const candidates = [delimiter, ',', '，', '\t'].filter(Boolean);
    let bestDelimiter = delimiter || ',';
    let bestCells = 0;
    for (const d of candidates) {
      const count = raw.split(d).length;
      if (count > bestCells) {
        bestCells = count;
        bestDelimiter = d;
      }
    }
    return raw.split(bestDelimiter).map((cell) => cell.trim());
  }

  parseScoreValue(value) {
    if (value == null) {
      return null;
    }
    const cleaned = String(value).replace(/[^\d.\-]/g, '');
    if (!cleaned) {
      return null;
    }
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }

  guessPeriodOrder(period, fallbackIndex = 0) {
    const text = String(period || '').trim();
    const monthHit = text.match(/(\d{1,2})\s*月/);
    if (monthHit?.[1]) {
      return Number(monthHit[1]);
    }
    const numHit = text.match(/(\d+(?:\.\d+)?)/);
    if (numHit?.[1]) {
      return Number(numHit[1]);
    }
    return fallbackIndex;
  }

  analyzeGradeTextLocally({ message, gradeText }) {
    const compactEntries = this.parseCompactGradeEntries(gradeText);
    if (compactEntries.length) {
      const lowerMessage = String(message || '').toLowerCase();
      const allStudents = [...new Set(compactEntries.map((item) => item.student))];
      const targetStudents = allStudents.filter((name) => lowerMessage.includes(String(name).toLowerCase()));
      const selectedStudents = targetStudents.length ? targetStudents : allStudents;

      const subjectPriority = ['语文', '数学', '英语', '总分'];
      const chunks = [];
      for (const student of selectedStudents) {
        const rows = compactEntries.filter((item) => item.student === student);
        if (!rows.length) {
          continue;
        }
        const ranked = [...rows].sort((a, b) => {
          const pa = subjectPriority.indexOf(a.subject);
          const pb = subjectPriority.indexOf(b.subject);
          return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
        });
        const avg = ranked.reduce((sum, item) => sum + item.score, 0) / ranked.length;
        chunks.push(`${student}：均分${avg.toFixed(1)}。${ranked.map((item) => `${item.subject}${item.score}分`).join('；')}。`);
      }

      let compareLine = '';
      if (selectedStudents.length >= 2) {
        const ranking = selectedStudents
          .map((student) => {
            const rows = compactEntries.filter((item) => item.student === student);
            const avg = rows.length ? rows.reduce((sum, item) => sum + item.score, 0) / rows.length : 0;
            return { student, avg };
          })
          .sort((a, b) => a.avg - b.avg);
        const weakest = ranking[0];
        const strongest = ranking[ranking.length - 1];
        compareLine = `对比：${strongest.student}当前表现更好（均分${strongest.avg.toFixed(1)}），${weakest.student}更需要补习。`;
      }

      return [chunks.join('\n'), compareLine].filter(Boolean).join('\n');
    }

    const lines = String(gradeText || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      return null;
    }

    const headerLine = lines.find((line) => /,|，|\t/.test(line));
    if (!headerLine) {
      return null;
    }
    const delimiter = this.detectTableDelimiter(headerLine);
    const headers = this.parseTableLine(headerLine, delimiter);
    if (headers.length < 2) {
      return null;
    }

    const studentIdx = headers.findIndex((h) => /(学生|姓名|student|name)/i.test(String(h)));
    const periodIdx = headers.findIndex((h) => /(月份|month|时间|日期|period)/i.test(String(h)));
    const classIdx = headers.findIndex((h) => /(班级|class)/i.test(String(h)));
    if (studentIdx < 0) {
      return null;
    }

    const subjectIndexes = headers
      .map((h, i) => ({ h: String(h || '').trim(), i }))
      .filter(({ i }) => i !== studentIdx && i !== periodIdx && i !== classIdx)
      .map(({ i }) => i);
    if (!subjectIndexes.length) {
      return null;
    }

    const tableStart = lines.indexOf(headerLine);
    const rows = [];
    for (const raw of lines.slice(tableStart + 1)) {
      if (!/,|，|\t/.test(raw)) {
        continue;
      }
      const cols = this.parseTableLine(raw, delimiter);
      const student = String(cols[studentIdx] || '').trim();
      if (!student) {
        continue;
      }
      const period = periodIdx >= 0 ? String(cols[periodIdx] || '').trim() : '';
      const subjects = [];
      for (const idx of subjectIndexes) {
        const score = this.parseScoreValue(cols[idx]);
        if (score == null) {
          continue;
        }
        subjects.push({
          subject: String(headers[idx] || '').trim() || `科目${idx}`,
          score,
        });
      }
      if (!subjects.length) {
        continue;
      }
      rows.push({ student, period, subjects });
    }

    if (!rows.length) {
      return null;
    }

    const allStudents = [...new Set(rows.map((r) => r.student))];
    const lowerMessage = String(message || '').toLowerCase();
    const targetStudents = allStudents.filter((name) => lowerMessage.includes(String(name).toLowerCase()));
    const selectedStudents = targetStudents.length ? targetStudents : allStudents;

    const chunks = [];
    for (const student of selectedStudents) {
      const studentRows = rows.filter((row) => row.student === student);
      if (!studentRows.length) {
        continue;
      }

      const bySubject = new Map();
      for (let i = 0; i < studentRows.length; i += 1) {
        const row = studentRows[i];
        for (const item of row.subjects) {
          if (!bySubject.has(item.subject)) {
            bySubject.set(item.subject, []);
          }
          bySubject.get(item.subject).push({
            period: row.period,
            order: this.guessPeriodOrder(row.period, i),
            score: item.score,
          });
        }
      }

      const allScores = [];
      const details = [];
      for (const [subject, values] of bySubject.entries()) {
        values.sort((a, b) => a.order - b.order);
        for (const v of values) {
          allScores.push(v.score);
        }
        const avg = values.reduce((sum, v) => sum + v.score, 0) / values.length;
        if (values.length >= 2) {
          const first = values[0];
          const last = values[values.length - 1];
          const delta = last.score - first.score;
          const sign = delta > 0 ? '+' : '';
          const trend = delta > 0 ? '上升' : delta < 0 ? '下降' : '持平';
          details.push(
            `${subject}${first.period ? `${first.period}` : '初次'}${first.score}→${last.period ? `${last.period}` : '最近'}${last.score}（${sign}${delta.toFixed(0)}，${trend}）`,
          );
        } else {
          details.push(`${subject}${avg.toFixed(1)}`);
        }
      }

      const overall = allScores.length
        ? (allScores.reduce((sum, score) => sum + score, 0) / allScores.length).toFixed(1)
        : '0.0';
      chunks.push(`${student}：均分${overall}。${details.join('；')}。`);
    }

    if (!chunks.length) {
      return null;
    }

    let compareLine = '';
    if (selectedStudents.length >= 2) {
      const ranking = selectedStudents
        .map((student) => {
          const scores = rows
            .filter((row) => row.student === student)
            .flatMap((row) => row.subjects.map((item) => item.score));
          const avg = scores.length ? scores.reduce((s, n) => s + n, 0) / scores.length : 0;
          return { student, avg };
        })
        .sort((a, b) => b.avg - a.avg);
      compareLine = `对比：${ranking[0].student}整体均分更高（${ranking[0].avg.toFixed(1)}），${ranking[ranking.length - 1].student}可优先补强薄弱科目。`;
    }

    return [chunks.join('\n'), compareLine].filter(Boolean).join('\n');
  }

  formatEssayIssue(item, index) {
    const original = String(item?.original || '').trim();
    const suggestion = String(item?.suggestion || '').trim();
    const reason = String(item?.reason || '').trim();
    const parts = [];
    if (original) {
      parts.push(`原文：${original}`);
    }
    if (suggestion) {
      parts.push(`建议：${suggestion}`);
    }
    if (reason) {
      parts.push(`说明：${reason}`);
    }
    return `${index + 1}. ${parts.join('；') || '已标记问题'}`;
  }

  formatRubricLine(item, index) {
    const criterion = String(item?.criterion || '').trim() || `评分项 ${index + 1}`;
    const awarded = Number.isFinite(item?.awarded_score) ? item.awarded_score : null;
    const max = Number.isFinite(item?.max_score) ? item.max_score : null;
    const scorePart =
      awarded != null && max != null
        ? `${awarded}/${max}`
        : awarded != null
          ? `${awarded}分`
          : max != null
            ? `满分 ${max}`
            : '未给出分值';
    const reason = String(item?.reason || '').trim();
    return `${index + 1}. ${criterion}：${scorePart}${reason ? `；${reason}` : ''}`;
  }

  formatEssayReviewReply(review, { topic = null } = {}) {
    const spelling = Array.isArray(review?.spelling_errors) ? review.spelling_errors : [];
    const grammar = Array.isArray(review?.grammar_issues) ? review.grammar_issues : [];
    const requirementSummary = Array.isArray(review?.requirement_summary) ? review.requirement_summary : [];
    const requirementMismatches = Array.isArray(review?.requirement_mismatches) ? review.requirement_mismatches : [];
    const scoringBreakdown = Array.isArray(review?.scoring_breakdown) ? review.scoring_breakdown : [];
    const topicReason = String(review?.topic_match_reason || '').trim();
    const overallFeedback = String(review?.overall_feedback || '').trim();
    const topicScoreUsable =
      topic &&
      Number.isFinite(review?.topic_match_score) &&
      !/(未提供主题|暂不评分|无法评分)/.test(topicReason) &&
      !/(未包含任何英语作文文本|无法进行批改|未识别出作文文本)/.test(overallFeedback);
    const lines = [];

    if (Number.isFinite(review?.estimated_score) || Number.isFinite(review?.full_score)) {
      const got = Number.isFinite(review?.estimated_score) ? review.estimated_score : '?';
      const full = Number.isFinite(review?.full_score) ? review.full_score : '?';
      lines.push(`客观评分：${got}/${full}`);
      if (review?.score_reason) {
        lines.push(`评分说明：${review.score_reason}`);
      }
      lines.push('');
    }

    if (requirementSummary.length) {
      lines.push('题目 / requirement 要点：');
      for (const [index, item] of requirementSummary.entries()) {
        lines.push(`${index + 1}. ${item}`);
      }
      lines.push('');
    }

    if (scoringBreakdown.length) {
      lines.push('得分拆解：');
      for (const [index, item] of scoringBreakdown.entries()) {
        lines.push(this.formatRubricLine(item, index));
      }
      lines.push('');
    }

    if (requirementMismatches.length) {
      lines.push('和 requirement 相比的主要问题：');
      for (const [index, item] of requirementMismatches.entries()) {
        lines.push(`${index + 1}. ${item}`);
      }
      lines.push('');
    }

    if (topic) {
      if (topicScoreUsable) {
        lines.push(`主题匹配度：${review.topic_match_score}/5`);
      } else {
        lines.push('主题匹配度：未评分');
      }
      if (topicReason) {
        lines.push(`匹配说明：${topicReason}`);
      }
    } else {
      if (Number.isFinite(review?.topic_match_score) && !/(未提供主题|暂不评分|无法评分)/.test(topicReason)) {
        lines.push(`主题匹配度：${review.topic_match_score}/5`);
        if (topicReason) {
          lines.push(`匹配说明：${topicReason}`);
        }
      } else {
        lines.push('主题匹配度：未单独评分（如需按你指定主题单独判断，请补一句“当前主题是 …”）');
      }
    }

    lines.push('');
    lines.push('病句 / 语法问题：');
    if (grammar.length) {
      for (const [index, item] of grammar.entries()) {
        lines.push(this.formatEssayIssue(item, index));
      }
    } else {
      lines.push('未发现明显病句或严重语法错误。');
    }

    lines.push('');
    lines.push('拼写问题：');
    if (spelling.length) {
      for (const [index, item] of spelling.entries()) {
        lines.push(this.formatEssayIssue(item, index));
      }
    } else {
      lines.push('未发现明显拼写错误。');
    }

    if (overallFeedback) {
      lines.push('');
      lines.push(`总体反馈：${overallFeedback}`);
    }

    return lines.join('\n');
  }

  parseLocalCommand(message) {
    const text = String(message || '').trim();
    const lower = text.toLowerCase();

    if (this.isCapabilityQuestion(text)) {
      return { info_only: true };
    }

    let path = this.extractPath(text);
    const patch = this.extractPatch(text);
    const dirLike = text.match(/([^\s，。；,;`"'“”‘’]+)\s*里有(?:什么|啥)/);

    if (patch) {
      if (!path) {
        return { error: '请提供要打补丁的文件路径，例如：对 `教材/讲义.md` 应用以下 patch ...' };
      }
      return { action: 'apply_patch', payload: { path, patch } };
    }

    if (/(删除|删掉|移除)/i.test(text) && /(文件|目录|文件夹|文档|路径|path|本地)/i.test(text)) {
      if (!path) {
        return { error: '请提供要删除的路径，例如：删除 文件: 教材/草稿.txt' };
      }
      const recursive = /(递归|整个目录|整个文件夹|目录及其内容|recursive)/i.test(text);
      return {
        action: 'delete_path',
        payload: {
          path,
          recursive,
        },
      };
    }

    const listIntent =
      (/(列出|查看|看看|有哪些|有什么|里有啥|里有什么|目录列表|文件列表|list|ls)/i.test(text) &&
        /(文件|目录|文件夹|本地|路径|path|教材)/i.test(text)) ||
      Boolean(dirLike?.[1]);

    if (listIntent) {
      return { action: 'list_dir', payload: { path: path || dirLike?.[1] || '.' } };
    }

    if (/(读取|读一下|打开|查看文件|read|cat|文件内容)/i.test(text)) {
      if (!path) {
        return { error: '请告诉我要读取哪个文件路径，例如：读取 文件: 教材/第一课.md' };
      }
      return { action: 'read_file', payload: { path } };
    }

    const createIntent =
      (/(创建|新建|生成|新增|建一个|建个)/i.test(text) && /(文件|文档|文本|txt|笔记)/i.test(text)) ||
      /(文件|文档|文本).*(叫|命名为|文件名|名称)/i.test(text);

    const writeIntent = /(写入|保存|覆盖|追加|更新|改写|修改|编辑|替换|记录|记下|记下来|记到|write|append)/i.test(text);

    if (writeIntent || createIntent) {
      if (!path) {
        path = this.inferDefaultWritePath(text);
      }
      if (!path) {
        return { error: '请提供目标路径或文件名，例如：创建文件，叫 BP.md' };
      }
      const content = this.extractContent(text) || this.extractImplicitWriteContent(text);
      if (!content && !createIntent) {
        return { error: '写入操作缺少内容。请用“内容: ...”或 ```text ...``` 提供文本。' };
      }
      return {
        action: 'write_file',
        payload: {
          path,
          content: content || '',
          append: /(追加|append)/i.test(lower),
        },
      };
    }

    return {
      error: '请补充更明确的本地文件操作，比如“列出本地目录”、“读取 xxx.md”、“写入 xxx.txt 内容: ...”。',
    };
  }

  formatDeviceResult(action, result) {
    if (action === 'list_dir') {
      const items = Array.isArray(result?.items) ? result.items : [];
      const preview = items.slice(0, 30).map((i) => `${i.type === 'dir' ? '[DIR]' : '[FILE]'} ${i.name}`);
      return [`目录：${result?.path || '-'}`, preview.length ? preview.join('\n') : '(空目录)', result?.truncated ? `...已截断，共 ${result.total} 项` : '']
        .filter(Boolean)
        .join('\n');
    }

    if (action === 'read_file') {
      const content = String(result?.content || '');
      const maxLen = 3000;
      const trimmed = content.length > maxLen ? `${content.slice(0, maxLen)}\n...(内容较长，已截断)` : content;
      return `文件：${result?.path || '-'}\n\n${trimmed || '(文件为空)'}`;
    }

    if (action === 'write_file') {
      return `已写入文件：${result?.path || '-'}（${result?.bytes ?? 0} bytes，${result?.append ? '追加' : '覆盖'}）`;
    }

    if (action === 'apply_patch') {
      return `已应用补丁：${result?.path || '-'}（${result?.bytes ?? 0} bytes）`;
    }

    if (action === 'delete_path') {
      return `已删除：${result?.path || '-'}（类型：${result?.kind || 'unknown'}）`;
    }

    return '本地命令执行成功。';
  }

  createPptResponse({ userId, uploadId, prompt = '' }) {
    if (!uploadId) {
      return {
        intent: 'ppt',
        reply: '识别到你要生成 PPT，请先上传教材图片，再提交 upload_id。',
        action: 'need_upload_id',
      };
    }
    const jobId = this.db.createJob({
      userId,
      type: 'ppt',
      input: { upload_id: uploadId, prompt: String(prompt || '') },
    });
    return {
      intent: 'ppt',
      reply: `已创建 PPT 任务，job_id=${jobId}`,
      action: 'job_created',
      job_id: jobId,
    };
  }

  createGradesResponse({ userId, fileId, uploadId }) {
    const input = {};
    if (fileId) {
      input.file_id = fileId;
    }
    if (uploadId) {
      input.upload_id = uploadId;
    }
    if (!input.file_id && !input.upload_id) {
      return {
        intent: 'grades',
        reply: '识别到你要做成绩分析。请上传 csv/xlsx，或者上传成绩表图片。',
        action: 'need_grade_input',
      };
    }
    const jobId = this.db.createJob({
      userId,
      type: 'grades',
      input,
    });
    return {
      intent: 'grades',
      reply: `已创建成绩分析任务，job_id=${jobId}`,
      action: 'job_created',
      job_id: jobId,
    };
  }

  async handleGradesIntent({ userId, message, context = {}, history = [], picked }) {
    const direct = this.createGradesResponse({
      userId,
      fileId: context.file_id,
      uploadId: context.upload_id,
    });
    if (direct.action === 'job_created') {
      return direct;
    }

    const hintedPath = this.extractGradeFileHint(message);
    const historyPath = this.findGradeFilePathFromHistory(history);

    let gradeText = null;
    if (hintedPath && picked?.device) {
      try {
        const content = await this.readGradeTextFromDeviceFile({
          userId,
          deviceId: picked.device.id,
          filePath: hintedPath,
        });
        gradeText = this.extractGradeAnalysisText(content || '');
      } catch {
        gradeText = null;
      }
    }

    if (!gradeText) {
      gradeText = this.findGradeContextFromHistory(history);
    }

    if (!gradeText) {
      if (picked?.device) {
        try {
          const readPath =
            historyPath ||
            (await this.guessGradeFileFromDevice({
              userId,
              deviceId: picked.device.id,
            }));
          if (readPath) {
            const content = await this.readGradeTextFromDeviceFile({
              userId,
              deviceId: picked.device.id,
              filePath: readPath,
            });
            gradeText = this.extractGradeAnalysisText(content || '');
          }
        } catch {
          gradeText = null;
        }
      }
    }

    if (!gradeText) {
      if (hintedPath || historyPath) {
        return {
          intent: 'grades',
          reply: `我识别到你要基于成绩文件分析，但暂时没读到可解析的成绩表内容。请先让我读取文件：${hintedPath || historyPath}，或直接把表头和数据粘贴到对话里。`,
          action: 'need_grade_context_refresh',
        };
      }
      return direct;
    }

    const fastReply = this.analyzeGradeTextLocally({ message, gradeText });
    if (fastReply) {
      return {
        intent: 'grades',
        reply: fastReply,
        action: 'grades_context_analyzed',
      };
    }

    try {
      const reply = await this.modelClient.analyzeGradesFromContext({
        request: message,
        gradeText,
        history,
      });
      return {
        intent: 'grades',
        reply,
        action: 'grades_context_analyzed',
      };
    } catch (err) {
      return {
        intent: 'grades',
        reply: `已识别到成绩分析需求，但基于会话文本分析失败：${err.message || '未知错误'}。请直接重试一次，我会继续沿用当前会话里的成绩内容分析。`,
        action: 'grades_context_analyze_failed',
      };
    }
  }

  async handleEssayReviewIntent({ userId, message, context = {}, history = [], planned = null }) {
    if (!context.upload_id) {
      return {
        intent: 'essay_review',
        reply:
          '识别到你要检查英语作文。请先上传包含作文内容的图片；如果图片里也有题目要求/评分标准，我会按 requirement 逐项打分、指出缺项并检查病句与拼写。若你还想按自定义主题单独评分，请在消息里补一句“当前主题是 …”。',
        action: 'need_essay_upload',
      };
    }

    const upload = this.db.getUploadWithFiles({ userId, uploadId: context.upload_id });
    if (!upload || !upload.files.length) {
      return {
        intent: 'essay_review',
        reply: '当前作文图片上传不存在或已失效，请重新上传后再试。',
        action: 'essay_upload_missing',
      };
    }

    const imageFiles = upload.files.filter((file) => {
      const name = String(file?.filename || file?.path || '');
      const mime = String(file?.mime || '');
      return mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name);
    });

    if (!imageFiles.length) {
      return {
        intent: 'essay_review',
        reply: '这次上传里没有可识别的图片文件。请上传英语作文照片或截图。',
        action: 'essay_images_required',
      };
    }

    const topic = this.extractEssayTopic(message, history, planned?.essay_topic);
    try {
      const review = await this.modelClient.reviewEssayFromImages({
        imagePaths: imageFiles.map((file) => file.path),
        topic,
        request: message,
      });
      return {
        intent: 'essay_review',
        reply: this.formatEssayReviewReply(review, { topic }),
        action: 'essay_reviewed',
      };
    } catch (err) {
      return {
        intent: 'essay_review',
        reply: `作文图片分析失败：${err.message || '未知错误'}。请换一张更清晰的作文图片再试，或把当前主题一并写上。`,
        action: 'essay_review_failed',
      };
    }
  }

  async maybePlanMainAction({ message, history, hasOnlineDevice }) {
    try {
      return await this.modelClient.planMainAction({
        message,
        history,
        hasOnlineDevice,
      });
    } catch {
      return null;
    }
  }

  async handleLocalFileIntent({ userId, message, history, planned = null, preferredDeviceId = null }) {
    const picked = this.pickOnlineDevice(userId, preferredDeviceId);
    if (!picked.device) {
      if (picked.reason === 'no_device') {
        return {
          intent: 'local_file',
          reply: '当前没有已注册的本地设备。请先在 Mac 启动 Local Agent，输入同一邀请码完成注册。',
          action: 'need_local_agent',
        };
      }
      return {
        intent: 'local_file',
        reply: '检测到你有本地设备记录，但设备当前不在线。请先在 Mac 打开 Local Agent 后再试。',
        action: 'device_offline',
      };
    }

    const excelPath = this.extractGradeFileHint(message);
    const studentUpdate = this.extractStudentScoreUpdate(message);
    if (excelPath && /\.(xlsx|xls)$/i.test(excelPath) && studentUpdate) {
      try {
        const updated = await this.upsertStudentScoresInExcel({
          userId,
          deviceId: picked.device.id,
          filePath: excelPath,
          studentUpdate,
        });
        return {
          intent: 'local_file',
          reply: `${updated.created ? '已新增' : '已更新'}学生 ${studentUpdate.student} 的成绩，文件：${updated.path}（工作表：${updated.sheetName}）。`,
          action: 'excel_grade_updated',
          device_id: picked.device.id,
        };
      } catch (err) {
        const messageText = String(err?.message || '未知错误');
        return {
          intent: 'local_file',
          reply: `更新 Excel 成绩失败：${messageText}。请确认文件名准确无误，并且该表第一张工作表里有“姓名/语文/数学/英语”列，或至少允许自动补这些列。`,
          action: 'excel_grade_update_failed',
        };
      }
    }

    let parsed = null;
    parsed = this.normalizePlannedLocalCommand(planned, message);
    if (!parsed) {
      parsed = this.parseLocalCommand(message);
    }

    if (parsed.info_only) {
      return {
        intent: 'local_file',
        reply: `可以访问。本地设备在线，授权目录：${picked.device.allowed_root || '(未上报)'}。你可以直接说“列出目录”“读取某文件”“写入某文件内容”。`,
        action: 'local_capability_explained',
      };
    }

    if (parsed.error) {
      const plannedFallback = await this.maybePlanMainAction({
        message,
        history,
        hasOnlineDevice: Boolean(picked.device),
      });
      const normalizedFallback = this.normalizePlannedLocalCommand(plannedFallback, message);
      if (normalizedFallback) {
        parsed = normalizedFallback;
      } else if (
        plannedFallback?.intent === 'ppt' ||
        plannedFallback?.intent === 'grades' ||
        plannedFallback?.intent === 'essay_review' ||
        plannedFallback?.intent === 'weather' ||
        plannedFallback?.intent === 'chat'
      ) {
        return { reroute_intent: plannedFallback.intent, reroute_plan: plannedFallback };
      } else {
        return {
          intent: 'local_file',
          reply: parsed.error,
          action: 'need_local_command_details',
        };
      }
    }

    try {
      const executed = await this.hub.request({
        userId,
        deviceId: picked.device.id,
        action: parsed.action,
        payload: parsed.payload || {},
      });

      return {
        intent: 'local_file',
        reply: this.formatDeviceResult(parsed.action, executed.result),
        action: 'device_command_executed',
        device_id: picked.device.id,
        command_id: executed.command_id,
        command_action: parsed.action,
      };
    } catch (err) {
      const messageText = String(err?.message || '未知错误');
      if (/不支持的 action:\s*(list_dir|delete_path)/i.test(messageText)) {
        return {
          intent: 'local_file',
          reply: '你的 Local Agent 版本较旧，不支持当前命令。请更新并重启本地 Agent（或重新安装最新 DMG）后再试。',
          action: 'device_agent_upgrade_needed',
        };
      }
      return {
        intent: 'local_file',
        reply: `本地命令执行失败：${messageText}。请确认 Local Agent 在线并且路径在授权目录内。`,
        action: 'device_command_failed',
      };
    }
  }

  async handleWeatherIntent({ userId, message, picked, planned }) {
    const city = this.extractWeatherCity(message, planned?.weather_city);
    if (!city) {
      return {
        intent: 'weather',
        reply: '请补充城市名，例如：“查深圳未来 7 天天气”。',
        action: 'need_weather_city',
      };
    }

    let report;
    try {
      report = await this.weatherService.get7DayForecast({ cityName: city });
    } catch (err) {
      return {
        intent: 'weather',
        reply: `联网天气查询失败：${err.message || '未知错误'}。请稍后重试。`,
        action: 'weather_fetch_failed',
      };
    }

    const weatherText = this.weatherService.formatForecastText(report);
    const writePath = this.extractWeatherWritePath(message, planned?.weather_write_path);
    if (!writePath) {
      return {
        intent: 'weather',
        reply: weatherText,
        action: 'weather_report',
      };
    }

    if (!picked.device) {
      return {
        intent: 'weather',
        reply: `天气已查到，但本地设备离线，暂时无法写入文件 ${writePath}。\n\n${weatherText}`,
        action: 'weather_ready_but_device_offline',
      };
    }

    try {
      const executed = await this.hub.request({
        userId,
        deviceId: picked.device.id,
        action: 'write_file',
        payload: {
          path: writePath,
          content: weatherText,
          append: false,
        },
      });
      return {
        intent: 'weather',
        reply: `已完成：${report.city}未来 7 天天气已写入 ${executed?.result?.path || writePath}。`,
        action: 'weather_written',
        device_id: picked.device.id,
        command_id: executed.command_id,
      };
    } catch (err) {
      return {
        intent: 'weather',
        reply: `天气已查到，但写入文件失败：${err.message || '未知错误'}。\n\n你可先手动复制以下内容：\n${weatherText}`,
        action: 'weather_write_failed',
      };
    }
  }

  async handleChat({ userId, sessionId, message, context = {} }) {
    this.db.createMessage({ userId, sessionId, role: 'user', content: message });
    const history = this.db.listRecentMessagesForSession({ userId, sessionId, limit: 60 });
    const picked = this.pickOnlineDevice(userId, context.device_id);

    const planned = await this.maybePlanMainAction({
      message,
      history,
      hasOnlineDevice: Boolean(picked.device),
    });

    const inferredIntent = this.inferIntent(message);
    let intent = planned?.intent || inferredIntent;
    if (this.isExcelGradeMutationRequest(message)) {
      intent = 'local_file';
    }
    if (inferredIntent === 'essay_review') {
      intent = 'essay_review';
    }

    if (intent === 'ppt') {
      return this.withSession(
        this.createPptResponse({
          userId,
          uploadId: context.upload_id,
          prompt: message,
        }),
        sessionId,
      );
    }

    if (intent === 'essay_review') {
      return this.withSession(
        await this.handleEssayReviewIntent({
          userId,
          message,
          context,
          history,
          planned,
        }),
        sessionId,
      );
    }

    if (intent === 'grades') {
      return this.withSession(
        await this.handleGradesIntent({
          userId,
          message,
          context,
          history,
          picked,
        }),
        sessionId,
      );
    }

    if (intent === 'weather') {
      return this.withSession(await this.handleWeatherIntent({ userId, message, picked, planned }), sessionId);
    }

    if (intent === 'local_file') {
      const localResult = await this.handleLocalFileIntent({
        userId,
        message,
        history,
        planned,
        preferredDeviceId: context.device_id,
      });
      if (localResult?.reroute_intent) {
        intent = localResult.reroute_intent;
      } else {
        return this.withSession(localResult, sessionId);
      }
    }

    if (intent === 'ppt') {
      return this.withSession(
        this.createPptResponse({
          userId,
          uploadId: context.upload_id,
          prompt: message,
        }),
        sessionId,
      );
    }

    if (intent === 'essay_review') {
      return this.withSession(
        await this.handleEssayReviewIntent({
          userId,
          message,
          context,
          history,
          planned,
        }),
        sessionId,
      );
    }

    if (intent === 'grades') {
      return this.withSession(
        await this.handleGradesIntent({
          userId,
          message,
          context,
          history,
          picked,
        }),
        sessionId,
      );
    }

    if (intent === 'weather') {
      return this.withSession(await this.handleWeatherIntent({ userId, message, picked, planned }), sessionId);
    }

    if (this.isShortProbeInput(message)) {
      return this.withSession(
        {
          intent: 'chat',
          reply: '已收到。你可以直接说具体任务，比如“列出本地目录内容”或“根据教材图生成 PPT”。',
          action: 'chat_reply',
        },
        sessionId,
      );
    }

    try {
      const reply = await this.modelClient.generateGeneralReply({
        message,
        history,
        hasOnlineDevice: Boolean(picked.device),
        allowedRoot: picked.device?.allowed_root || '',
      });
      return this.withSession(
        {
          intent: 'chat',
          reply,
          action: 'chat_reply',
        },
        sessionId,
      );
    } catch (err) {
      return this.withSession(
        {
          intent: 'chat',
          reply: `通用对话失败：${err.message || '未知错误'}。请重试，或直接上传教材图/成绩表继续。`,
          action: 'chat_fallback',
        },
        sessionId,
      );
    }
  }
}
