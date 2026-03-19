(function main() {
  const DEFAULT_SERVER_URL = 'http://47.109.111.160:8080';
  const SESSION_INDEX_CACHE_KEY = 'teacher-ai-session-index-v1';
  const SESSION_MESSAGE_CACHE_KEY = 'teacher-ai-session-messages-v1';

  const MODE_CONFIG = {
    main: {
      title: 'Main Agent Chat',
      subtitle: '直接说需求，系统自动路由：PPT / 成绩 / 作文批改 / 本地文件操作 / 天气',
      placeholder: '直接输入：例如“检查这篇英语作文的病句和拼写，并判断是否符合主题”',
    },
  };

  const state = {
    authenticated: false,
    serverUrl: DEFAULT_SERVER_URL,
    selectedFiles: [],
    sending: false,
    polling: new Set(),
    deviceStatus: 'offline',
    pendingRow: null,
    sessions: [],
    activeSessionId: '',
    sessionMessages: new Map(),
    loadingSessionToken: '',
    isComposing: false,
    pptReasoningShown: new Set(),
    pendingUploads: new Map(),
    pendingAnswerKeys: new Map(),   // session_id -> { answer_key_id, page_count, question_count }
    pendingQuizResults: new Map(),  // session_id -> { result_id, job_id }
  };

  const ui = {
    deviceBadge: document.getElementById('deviceBadge'),
    allowedRoot: document.getElementById('allowedRoot'),
    reopenSetupBtn: document.getElementById('reopenSetupBtn'),
    clearHistoryBtn: document.getElementById('clearHistoryBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    newChatBtn: document.getElementById('newChatBtn'),
    statusHint: document.getElementById('statusHint'),
    messages: document.getElementById('messages'),
    selectedFiles: document.getElementById('selectedFiles'),
    attachBtn: document.getElementById('attachBtn'),
    sendBtn: document.getElementById('sendBtn'),
    messageInput: document.getElementById('messageInput'),
    chatTitle: document.getElementById('chatTitle'),
    chatSubtitle: document.getElementById('chatSubtitle'),
    navMain: document.getElementById('navMain'),
    sessionList: document.getElementById('sessionList'),
    setupModal: document.getElementById('setupModal'),
    inviteInput: document.getElementById('inviteInput'),
    rootInput: document.getElementById('rootInput'),
    pickRootBtn: document.getElementById('pickRootBtn'),
    setupBtn: document.getElementById('setupBtn'),
    setupError: document.getElementById('setupError'),
  };

  function basename(value) {
    const str = String(value || '');
    const parts = str.split(/[\\/]/g);
    return parts[parts.length - 1] || str;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function formatTime(iso) {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleTimeString();
  }

  function sortSessions(sessions) {
    return [...sessions].sort((a, b) => {
      const aTs = new Date(a.last_message_at || a.updated_at || a.created_at || 0).getTime();
      const bTs = new Date(b.last_message_at || b.updated_at || b.created_at || 0).getTime();
      return bTs - aTs;
    });
  }

  function normalizeSession(raw) {
    const id = String(raw?.session_id || raw?.id || '').trim();
    if (!id) {
      return null;
    }
    return {
      session_id: id,
      title: String(raw?.title || '新会话'),
      created_at: raw?.created_at || nowIso(),
      updated_at: raw?.updated_at || raw?.created_at || nowIso(),
      last_message_at: raw?.last_message_at || raw?.updated_at || raw?.created_at || nowIso(),
    };
  }

  function normalizeMessage(raw) {
    const role = raw?.role === 'user' ? 'user' : raw?.role === 'assistant' ? 'assistant' : 'system';
    return {
      id: raw?.id ? String(raw.id) : '',
      session_id: raw?.session_id ? String(raw.session_id) : '',
      role,
      content: String(raw?.content || ''),
      created_at: raw?.created_at || nowIso(),
      links: Array.isArray(raw?.links) ? raw.links : [],
    };
  }

  function readCache(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) {
        return fallback;
      }
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeCache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore local cache failures
    }
  }

  function persistCaches() {
    writeCache(
      SESSION_INDEX_CACHE_KEY,
      state.sessions.slice(0, 80).map((s) => ({
        session_id: s.session_id,
        title: s.title,
        created_at: s.created_at,
        updated_at: s.updated_at,
        last_message_at: s.last_message_at,
      })),
    );

    const messageObj = {};
    for (const [sessionId, items] of state.sessionMessages.entries()) {
      messageObj[sessionId] = items.slice(-150);
    }
    writeCache(SESSION_MESSAGE_CACHE_KEY, messageObj);

    // Quiz caches: keep only entries in active sessions, max 20
    const validSids = new Set(state.sessions.map((s) => s.session_id));
    const quizKeysObj = {};
    let qkCount = 0;
    for (const [sid, val] of state.pendingAnswerKeys.entries()) {
      if (qkCount >= 20) break;
      if (!validSids.has(sid)) continue;
      quizKeysObj[sid] = val;
      qkCount += 1;
    }
    writeCache('teacher-ai-quiz-keys-v1', quizKeysObj);

    const quizResultsObj = {};
    let qrCount = 0;
    for (const [sid, val] of state.pendingQuizResults.entries()) {
      if (qrCount >= 20) break;
      if (!validSids.has(sid)) continue;
      quizResultsObj[sid] = val;
      qrCount += 1;
    }
    writeCache('teacher-ai-quiz-results-v1', quizResultsObj);
  }

  function hydrateCaches() {
    const cachedSessions = readCache(SESSION_INDEX_CACHE_KEY, [])
      .map(normalizeSession)
      .filter(Boolean);
    state.sessions = sortSessions(cachedSessions);

    const cachedMessages = readCache(SESSION_MESSAGE_CACHE_KEY, {});
    state.sessionMessages.clear();
    if (cachedMessages && typeof cachedMessages === 'object') {
      for (const [sessionId, rows] of Object.entries(cachedMessages)) {
        if (!Array.isArray(rows)) {
          continue;
        }
        state.sessionMessages.set(sessionId, rows.map(normalizeMessage));
      }
    }

    const cachedQuizKeys = readCache('teacher-ai-quiz-keys-v1', {});
    state.pendingAnswerKeys.clear();
    for (const [sid, val] of Object.entries(cachedQuizKeys || {})) {
      state.pendingAnswerKeys.set(sid, val);
    }
    const cachedQuizResults = readCache('teacher-ai-quiz-results-v1', {});
    state.pendingQuizResults.clear();
    for (const [sid, val] of Object.entries(cachedQuizResults || {})) {
      state.pendingQuizResults.set(sid, val);
    }
  }

  function scrollToBottom() {
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  function setStatusHint(text, tone = 'default') {
    ui.statusHint.textContent = text;
    ui.statusHint.className = 'pill';
    if (tone === 'busy') {
      ui.statusHint.classList.add('busy');
    } else if (tone === 'ok') {
      ui.statusHint.classList.add('ok');
    } else if (tone === 'error') {
      ui.statusHint.classList.add('error');
    }
  }

  function setComposerBusy(busy) {
    state.sending = busy;
    ui.sendBtn.disabled = busy;
    ui.attachBtn.disabled = busy;
    ui.sendBtn.textContent = busy ? '处理中...' : '发送';
  }

  function showSetup(show) {
    ui.setupModal.classList.toggle('show', Boolean(show));
  }

  function setDeviceBadge(status) {
    const normalized = ['online', 'connecting', 'offline', 'error'].includes(status) ? status : 'offline';
    const labels = {
      online: '在线',
      connecting: '连接中',
      offline: '离线',
      error: '异常',
    };
    state.deviceStatus = normalized;
    ui.deviceBadge.className = `badge ${normalized}`;
    ui.deviceBadge.textContent = labels[normalized];
  }

  function setHeader(snapshot) {
    state.authenticated = Boolean(snapshot?.authenticated);
    state.serverUrl = snapshot?.server_url || state.serverUrl;

    ui.allowedRoot.textContent = snapshot?.device?.allowed_root || '-';
    setDeviceBadge(snapshot?.device?.status || 'offline');

    if (!state.authenticated) {
      setStatusHint('未登录', 'error');
      return;
    }

    if (snapshot?.device?.status === 'online') {
      setStatusHint('Ready', 'ok');
      return;
    }
    setStatusHint('已登录', 'default');
  }

  function showSelectedFiles() {
    ui.selectedFiles.innerHTML = '';
    for (const filePath of state.selectedFiles) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = basename(filePath);
      ui.selectedFiles.appendChild(chip);
    }
  }

  function clearComposer() {
    ui.messageInput.value = '';
    state.selectedFiles = [];
    showSelectedFiles();
  }

  function getPendingUploadId(sessionId) {
    return sessionId ? state.pendingUploads.get(sessionId) || '' : '';
  }

  function setPendingUploadId(sessionId, uploadId) {
    if (!sessionId) {
      return;
    }
    if (!uploadId) {
      state.pendingUploads.delete(sessionId);
      return;
    }
    state.pendingUploads.set(sessionId, String(uploadId));
  }

  function clearPending() {
    if (!state.pendingRow) {
      return;
    }
    state.pendingRow.remove();
    state.pendingRow = null;
  }

  function getMessagesForSession(sessionId) {
    return state.sessionMessages.get(sessionId) || [];
  }

  function setMessagesForSession(sessionId, messages) {
    state.sessionMessages.set(sessionId, messages.map(normalizeMessage));
    persistCaches();
  }

  function pushMessageToSession(sessionId, message) {
    const list = [...getMessagesForSession(sessionId), normalizeMessage(message)];
    state.sessionMessages.set(sessionId, list);
    persistCaches();
  }

  function updateSessionTimestamp(sessionId, iso = nowIso()) {
    let changed = false;
    state.sessions = state.sessions.map((item) => {
      if (item.session_id !== sessionId) {
        return item;
      }
      changed = true;
      return {
        ...item,
        updated_at: iso,
        last_message_at: iso,
      };
    });
    if (changed) {
      state.sessions = sortSessions(state.sessions);
      persistCaches();
      renderSessionList();
    }
  }

  function bindMessageId({ sessionId, role, createdAt, messageId }) {
    if (!sessionId || !messageId) {
      return;
    }
    const rows = getMessagesForSession(sessionId);
    if (!rows.length) {
      return;
    }

    let matched = false;
    const next = rows.map((item) => {
      if (matched) {
        return item;
      }
      if (item.id) {
        return item;
      }
      if (item.role !== role) {
        return item;
      }
      if (createdAt && item.created_at !== createdAt) {
        return item;
      }
      matched = true;
      return {
        ...item,
        id: String(messageId),
        session_id: sessionId,
      };
    });
    if (matched) {
      state.sessionMessages.set(sessionId, next);
      persistCaches();
      if (sessionId === state.activeSessionId) {
        renderActiveSession();
      }
    }
  }

  async function deleteMessageFromSession({ sessionId, messageId }) {
    if (!sessionId || !messageId) {
      throw new Error('缺少会话或消息标识');
    }
    await window.desktopApi.deleteMessage(messageId);
    const rows = getMessagesForSession(sessionId).filter((item) => item.id !== String(messageId));
    state.sessionMessages.set(sessionId, rows);
    persistCaches();
    if (sessionId === state.activeSessionId) {
      renderActiveSession();
    }
    try {
      await fetchSessionsFromCloud();
    } catch {
      // keep local state on temporary sync failures
    }
  }

  function removeSessionLocal(sessionId) {
    state.sessions = state.sessions.filter((item) => item.session_id !== sessionId);
    state.sessionMessages.delete(sessionId);
    state.pendingUploads.delete(sessionId);
    persistCaches();
    renderSessionList();
  }

  function renderSingleMessage(item) {
    const row = document.createElement('div');
    row.className = `row ${item.role}`;

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = item.content;
    if (item.id) {
      bubble.title = '右键删除这条消息';
      bubble.addEventListener('contextmenu', async (event) => {
        event.preventDefault();
        if (state.sending) {
          return;
        }
        const ok = window.confirm('删除这条消息后无法恢复，确定删除吗？');
        if (!ok) {
          return;
        }
        try {
          await deleteMessageFromSession({
            sessionId: state.activeSessionId,
            messageId: item.id,
          });
        } catch (err) {
          appendMessage({
            sessionId: state.activeSessionId,
            role: 'assistant',
            content: `删除消息失败：${err.message}`,
          });
        }
      });
    }

    if (item.links?.length > 0) {
      const box = document.createElement('div');
      box.className = 'links';
      for (const link of item.links) {
        const button = document.createElement('button');
        button.className = 'link-btn';
        button.textContent = link.label;
        button.style.cursor = 'pointer';
        button.addEventListener('click', async () => {
          try {
            await window.desktopApi.openDownload(link.url);
          } catch (err) {
            appendMessage({
              sessionId: state.activeSessionId,
              role: 'assistant',
              content: `打开下载链接失败：${err.message}`,
            });
          }
        });
        box.appendChild(button);
      }
      bubble.appendChild(box);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = formatTime(item.created_at);
    bubble.appendChild(meta);

    row.appendChild(bubble);
    ui.messages.appendChild(row);
  }

  function renderActiveSession() {
    ui.messages.innerHTML = '';
    clearPending();

    const sessionId = state.activeSessionId;
    if (!sessionId) {
      return;
    }

    const messages = getMessagesForSession(sessionId);
    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'row system';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = '会话已创建。你可以直接输入需求或添加附件。';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = formatTime(nowIso());
      bubble.appendChild(meta);
      empty.appendChild(bubble);
      ui.messages.appendChild(empty);
      scrollToBottom();
      return;
    }

    for (const item of messages) {
      renderSingleMessage(item);
    }
    scrollToBottom();
  }

  function appendMessage({ sessionId, role, content, links = [], created_at = nowIso(), persist = true, id = '' }) {
    clearPending();
    const sid = sessionId || state.activeSessionId;
    const payload = {
      id: id ? String(id) : '',
      session_id: sid || '',
      role,
      content: String(content || ''),
      links,
      created_at,
    };
    if (persist && sid) {
      pushMessageToSession(sid, payload);
      if (role === 'user' || role === 'assistant') {
        updateSessionTimestamp(sid, created_at);
      }
    }
    if (sid === state.activeSessionId || !state.activeSessionId) {
      renderSingleMessage(payload);
      scrollToBottom();
    }
  }

  function upsertPending(text, sessionId = state.activeSessionId) {
    if (sessionId !== state.activeSessionId) {
      return;
    }

    if (!state.pendingRow) {
      const row = document.createElement('div');
      row.className = 'row pending';

      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text;

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = formatTime(nowIso());
      bubble.appendChild(meta);

      row.appendChild(bubble);
      ui.messages.appendChild(row);
      state.pendingRow = row;
      scrollToBottom();
      return;
    }

    const bubble = state.pendingRow.querySelector('.bubble');
    if (bubble) {
      bubble.firstChild.textContent = text;
    }
    const meta = state.pendingRow.querySelector('.meta');
    if (meta) {
      meta.textContent = formatTime(nowIso());
    }
  }

  function upsertSession(rawSession) {
    const session = normalizeSession(rawSession);
    if (!session) {
      return;
    }
    let found = false;
    state.sessions = state.sessions.map((item) => {
      if (item.session_id !== session.session_id) {
        return item;
      }
      found = true;
      return { ...item, ...session };
    });
    if (!found) {
      state.sessions.push(session);
    }
    state.sessions = sortSessions(state.sessions);
    persistCaches();
    renderSessionList();
  }

  function renderSessionList() {
    ui.sessionList.innerHTML = '';

    if (!state.sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'record';
      empty.textContent = '暂无会话';
      ui.sessionList.appendChild(empty);
      return;
    }

    for (const session of state.sessions) {
      const shell = document.createElement('div');
      shell.className = 'record-shell';

      const row = document.createElement('button');
      row.type = 'button';
      row.className = `record ${state.activeSessionId === session.session_id ? 'active' : ''}`;
      row.addEventListener('click', () => {
        openSession(session.session_id);
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'record-delete';
      removeBtn.textContent = 'x';
      removeBtn.title = '删除会话';
      removeBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const ok = window.confirm(`确定删除会话“${session.title || '新会话'}”吗？`);
        if (!ok) {
          return;
        }
        try {
          await window.desktopApi.deleteSession(session.session_id);
          removeSessionLocal(session.session_id);
          if (state.activeSessionId === session.session_id) {
            const next = state.sessions[0]?.session_id || '';
            if (next) {
              await openSession(next);
            } else {
              await createNewSession();
            }
          }
          setStatusHint('会话已删除', 'ok');
        } catch (err) {
          appendMessage({
            sessionId: state.activeSessionId || '__local__',
            role: 'assistant',
            content: `删除会话失败：${err.message}`,
          });
          setStatusHint('删除失败', 'error');
        }
      });

      const title = document.createElement('div');
      title.className = 'record-title';
      title.textContent = session.title || '新会话';
      row.appendChild(title);

      const time = document.createElement('div');
      time.className = 'record-time';
      time.textContent = formatTime(session.last_message_at || session.updated_at || session.created_at);
      row.appendChild(time);

      shell.appendChild(row);
      shell.appendChild(removeBtn);
      ui.sessionList.appendChild(shell);
    }
  }

  function setMode() {
    const cfg = MODE_CONFIG.main;

    ui.chatTitle.textContent = cfg.title;
    ui.chatSubtitle.textContent = cfg.subtitle;
    ui.messageInput.placeholder = cfg.placeholder;
  }

  function detectIntent(text, filePaths) {
    const message = String(text || '');
    const lower = message.toLowerCase();
    const hasImage = filePaths.some((f) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(f));
    const hasSheet = filePaths.some((f) => /\.(csv|xlsx|xls)$/i.test(f));
    const gradeHint = /(成绩|分数|成绩单|平均分|排名|班级统计|及格率|月考|期中|期末|csv|xlsx|xls)/i;

    if (hasSheet) {
      return 'grades';
    }

    const quizHint = /(过关单|批改过关|答案录入|答题卡|批改试卷|上传.*答案|答案.*上传|开始批改)/i;
    if (quizHint.test(message)) {
      const sid = state.activeSessionId;
      if (hasImage && !state.pendingAnswerKeys.has(sid)) return 'quiz_answer_key';
      if (hasImage && state.pendingAnswerKeys.has(sid)) return 'quiz_grade_papers';
      if (!hasImage && state.pendingAnswerKeys.has(sid)) return 'quiz_grade_papers';
      return 'quiz_answer_key';
    }
    if (gradeHint.test(message)) {
      return 'grades';
    }
    if (/ppt|课件|幻灯|投影片/.test(message)) {
      return 'ppt';
    }
    if (/本地|目录|文件夹|文件里有什么|read_file|write_file|apply_patch|ls|list|读取文件|写入文件|帮我看/.test(lower)) {
      return 'local_file';
    }
    return 'chat';
  }

  async function pollJob(jobId, sessionId) {
    if (state.polling.has(jobId)) {
      return;
    }
    state.polling.add(jobId);
    setStatusHint('任务进行中', 'busy');

    let previous = '';
    let lastProgress = '';
    for (let i = 0; i < 180; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const job = await window.desktopApi.getJob(jobId);

        const currentProgress = job.result?.progress || '';
        if (currentProgress && currentProgress !== lastProgress) {
          lastProgress = currentProgress;
          upsertPending(`任务 ${jobId}：${currentProgress}`, sessionId);
        }

        if (job.status !== previous) {
          previous = job.status;
          appendMessage({
            sessionId,
            role: 'system',
            content: `任务 ${jobId} 状态：${job.status}`,
          });
        }

        if (
          job.type === 'ppt' &&
          job.status === 'outline_ready' &&
          job?.result?.reasoning &&
          !state.pptReasoningShown.has(jobId)
        ) {
          state.pptReasoningShown.add(jobId);
          appendMessage({
            sessionId,
            role: 'assistant',
            content: `PPT 规划与意图拆解：\n${job.result.reasoning}`,
          });
        }

        if (job.status === 'done') {
          const result = job.result || {};
          if (job.type === 'ppt') {
            const links = [];
            if (result.ppt_url) {
              links.push({ label: '下载 PPT', url: result.ppt_url });
            }
            appendMessage({
              sessionId,
              role: 'assistant',
              content: `PPT 已生成完成，共 ${result?.outline?.pages?.length || 0} 页。生成方式：${result?.provider || 'unknown'}${
                result?.provider_error ? `（已自动兜底：${result.provider_error}）` : ''
              }`,
              links,
            });
          } else if (job.type === 'grades') {
            const links = [];
            if (result.csv_download_url) {
              links.push({ label: '下载 CSV', url: result.csv_download_url });
            }
            if (result.xlsx_download_url) {
              links.push({ label: '下载 XLSX', url: result.xlsx_download_url });
            }
            const summary = result.summary || {};
            appendMessage({
              sessionId,
              role: 'assistant',
              content: `成绩分析完成。记录数：${summary.total_records ?? '-'}，平均分：${summary.overall_avg ?? '-'}`,
              links,
            });
          } else if (job.type === 'quiz_key') {
            const answerId = result.answer_key_id;
            const pageCount = result.page_count || 0;
            const questionCount = result.question_count || 0;
            const lowConf = result.low_confidence_questions || [];
            if (answerId) {
              state.pendingAnswerKeys.set(sessionId, { answer_key_id: answerId, page_count: pageCount, question_count: questionCount });
              persistCaches();
            }
            let text = `✅ 答案已识别，共 ${questionCount} 题（${pageCount} 页）。`;
            const byPage = result.questions_by_page || [];
            if (byPage.length > 0) {
              text += '\n\n📋 答案预览：';
              for (const page of byPage) {
                const preview = page.questions.slice(0, 8).map((q) => `${q.number}. ${q.correct_answer}`).join('  ');
                const ellipsis = page.questions.length > 8 ? '  ...' : '';
                text += `\n第 ${page.range_start}-${page.range_end} 题（第 ${page.page} 页）：\n  ${preview}${ellipsis}`;
              }
            }
            if (lowConf.length > 0) {
              text += `\n\n⚠️ 以下 ${lowConf.length} 题识别可能有误，请重点检查：`;
              for (const item of lowConf) {
                text += `\n  #${item.number}: 当前识别为 "${item.correct_answer}"（置信度低）`;
              }
              text += '\n\n确认无误请说"没问题"。如需修正，输入如 "47:movable" 即可。';
            } else {
              text += '\n\n确认无误请说"没问题"，然后上传学生答卷照片。';
            }
            appendMessage({ sessionId, role: 'assistant', content: text });
          } else if (job.type === 'quiz_grade') {
            const summary = result.summary || {};
            const lowConf = result.low_confidence_items || [];
            const failed = result.failed_students || [];
            const links = [];
            if (result.xlsx_download_url) links.push({ label: '下载 Excel', url: result.xlsx_download_url });
            if (result.csv_download_url) links.push({ label: '下载 CSV', url: result.csv_download_url });
            if (result.result_id) {
              state.pendingQuizResults.set(sessionId, { result_id: result.result_id, job_id: jobId });
              persistCaches();
            }
            let text = `✅ 批改完成！共 ${summary.student_count || '-'} 位学生`;
            text += `\n\n📊 班级概况：平均 ${summary.average ?? '-'}`;
            if (summary.max_student) text += ` | 最高 ${summary.max_rate} ${summary.max_student}`;
            if (summary.min_student) text += ` | 最低 ${summary.min_rate} ${summary.min_student}`;
            if (summary.high_error_questions?.length > 0) {
              text += '\n📌 高频错题：';
              text += summary.high_error_questions.map((q) => `#${q.question_number} ${q.correct_answer}（错误率 ${q.error_rate}）`).join('、');
            }
            if (lowConf.length > 0) {
              text += `\n⚠️ ${lowConf.length} 道题需要你确认（OCR 不确定）`;
              text += '\n  回复"查看确认题"可逐条复核，或说"全部按系统判定"跳过。';
            }
            if (failed.length > 0) {
              text += `\n\n⚠️ ${failed.length} 位学生识别失败：`;
              for (const f of failed) text += `\n  - 第 ${f.photo_index + 1} 张照片起：${f.reason}`;
            }
            appendMessage({ sessionId, role: 'assistant', content: text, links });
          } else {
            appendMessage({
              sessionId,
              role: 'assistant',
              content: `任务完成：${jobId}`,
            });
          }
          setStatusHint('任务完成', 'ok');
          break;
        }

        if (job.status === 'failed') {
          appendMessage({
            sessionId,
            role: 'assistant',
            content: `任务失败：${job.error || '未知错误'}`,
          });
          setStatusHint('任务失败', 'error');
          break;
        }
      } catch (err) {
        appendMessage({
          sessionId,
          role: 'assistant',
          content: `查询任务失败：${err.message}`,
        });
        setStatusHint('任务查询失败', 'error');
        break;
      }
    }

    state.polling.delete(jobId);
  }

  async function handleAgentReply(reply, sessionId, meta = {}) {
    if (reply?.messages?.user?.id) {
      bindMessageId({
        sessionId,
        role: 'user',
        createdAt: meta?.userCreatedAt || '',
        messageId: reply.messages.user.id,
      });
    }

    if (reply?.reply) {
      appendMessage({
        sessionId,
        role: 'assistant',
        content: reply.reply,
        id: reply?.messages?.assistant?.id || '',
        created_at: reply?.messages?.assistant?.created_at || nowIso(),
      });
    }

    if (reply?.action === 'job_created' && reply?.job_id) {
      pollJob(reply.job_id, sessionId);
      return;
    }

    if (reply?.action === 'chat_reply' || reply?.action === 'device_command_executed' || reply?.action === 'weather_written') {
      setStatusHint('已完成', 'ok');
    } else if (
      reply?.action === 'chat_fallback' ||
      reply?.action === 'device_command_failed' ||
      reply?.action === 'weather_fetch_failed' ||
      reply?.action === 'weather_write_failed'
    ) {
      setStatusHint('执行失败', 'error');
    } else {
      setStatusHint('Ready', state.deviceStatus === 'online' ? 'ok' : 'default');
    }
  }

  async function fetchSessionsFromCloud() {
    const response = await window.desktopApi.listSessions();
    const cloudSessions = Array.isArray(response?.sessions) ? response.sessions.map(normalizeSession).filter(Boolean) : [];
    state.sessions = sortSessions(cloudSessions);
    persistCaches();
    renderSessionList();
    return state.sessions;
  }

  async function createNewSession() {
    if (!state.authenticated) {
      showSetup(true);
      ui.setupError.textContent = '请先完成首次配置（邀请码 + 授权目录）。';
      return null;
    }

    const created = await window.desktopApi.createSession({ title: '新会话' });
    const normalized = normalizeSession(created);
    if (!normalized) {
      throw new Error('创建会话失败');
    }
    upsertSession(normalized);
    state.activeSessionId = normalized.session_id;
    setMessagesForSession(normalized.session_id, []);
    renderSessionList();
    renderActiveSession();
    setStatusHint('Ready', state.deviceStatus === 'online' ? 'ok' : 'default');
    return normalized.session_id;
  }

  async function openSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) {
      return;
    }
    state.activeSessionId = sid;
    renderSessionList();

    if (state.sessionMessages.has(sid)) {
      renderActiveSession();
    } else {
      ui.messages.innerHTML = '';
    }

    const loadToken = `${sid}:${Date.now()}`;
    state.loadingSessionToken = loadToken;
    setStatusHint('同步会话中', 'busy');

    try {
      const response = await window.desktopApi.getSessionMessages(sid);
      if (state.loadingSessionToken !== loadToken) {
        return;
      }
      const messages = Array.isArray(response?.messages) ? response.messages.map(normalizeMessage) : [];
      setMessagesForSession(sid, messages);
      if (response?.session) {
        upsertSession(response.session);
      }
      renderActiveSession();
      setStatusHint('Ready', state.deviceStatus === 'online' ? 'ok' : 'default');
    } catch (err) {
      if (!state.sessionMessages.has(sid)) {
        appendMessage({
          sessionId: sid,
          role: 'system',
          content: `云端同步暂不可用：${err.message}`,
        });
      }
      setStatusHint('云端同步异常', 'error');
      renderActiveSession();
    }
  }

  async function ensureActiveSession() {
    if (state.activeSessionId) {
      return state.activeSessionId;
    }
    if (!state.sessions.length) {
      return createNewSession();
    }
    await openSession(state.sessions[0].session_id);
    return state.activeSessionId;
  }

  async function sendMessage() {
    if (state.sending) {
      return;
    }

    const text = ui.messageInput.value.trim();
    const files = [...state.selectedFiles];
    if (!text && files.length === 0) {
      return;
    }

    if (!state.authenticated) {
      showSetup(true);
      ui.setupError.textContent = '请先完成首次配置（邀请码 + 授权目录）。';
      return;
    }

    const sessionId = await ensureActiveSession();
    if (!sessionId) {
      return;
    }
    const pendingUploadId = getPendingUploadId(sessionId);

    const userText = text || '[发送了附件]';
    const userCreatedAt = nowIso();
    if (files.length > 0) {
      appendMessage({
        sessionId,
        role: 'user',
        content: `${userText}\n附件：${files.map((p) => basename(p)).join('、')}`,
        created_at: userCreatedAt,
      });
    } else {
      appendMessage({
        sessionId,
        role: 'user',
        content: userText,
        created_at: userCreatedAt,
      });
    }

    clearComposer();
    setComposerBusy(true);

    try {
      const intent = detectIntent(text, files);

      if (intent === 'ppt' && files.length > 0) {
        setStatusHint('上传教材中', 'busy');
        upsertPending('正在上传图片...', sessionId);
        const upload = await window.desktopApi.uploadImages({ filePaths: files });
        setPendingUploadId(sessionId, upload.upload_id);
        appendMessage({
          sessionId,
          role: 'system',
          content: `已上传图片，upload_id=${upload.upload_id}`,
        });

        upsertPending('正在生成 PPT 任务...', sessionId);
        const reply = await window.desktopApi.sendChat({
          message: text || '请根据这些教材图片生成PPT',
          session_id: sessionId,
          upload_id: upload.upload_id,
        });
        await handleAgentReply(reply, sessionId, { userCreatedAt });
        return;
      }

      if (intent === 'grades' && files.length > 0) {
        setStatusHint('上传成绩中', 'busy');
        upsertPending('正在创建成绩分析任务...', sessionId);
        const job = await window.desktopApi.createGradesJob({ filePaths: files });
        appendMessage({
          sessionId,
          role: 'assistant',
          content: `已创建成绩分析任务，job_id=${job.job_id}`,
        });
        pollJob(job.job_id, sessionId);
        return;
      }

      if (intent === 'quiz_answer_key' && files.length > 0) {
        setStatusHint('上传答案中', 'busy');
        upsertPending('正在上传标准答案照片...', sessionId);
        const upload = await window.desktopApi.uploadImages({ filePaths: files });
        setPendingUploadId(sessionId, upload.upload_id);
        appendMessage({ sessionId, role: 'system', content: `已上传 ${files.length} 张答案照片` });
        appendMessage({ sessionId, role: 'system', content: '💡 建议确保文字清晰、无遮挡。若识别结果不佳可重新上传。' });
        upsertPending('正在识别标准答案...', sessionId);
        const reply = await window.desktopApi.sendChat({
          message: text || '这是标准答案',
          session_id: sessionId,
          upload_id: upload.upload_id,
        });
        await handleAgentReply(reply, sessionId, { userCreatedAt });
        return;
      }

      if (intent === 'quiz_grade_papers') {
        const pending = state.pendingAnswerKeys.get(sessionId);
        const quizResult = state.pendingQuizResults.get(sessionId);
        const chatPayload = {
          message: text || '开始批改',
          session_id: sessionId,
          upload_id: pendingUploadId || undefined,
          answer_key_id: pending?.answer_key_id,
          quiz_result_id: quizResult?.result_id,
        };
        if (files.length > 0) {
          setStatusHint('上传学生答卷中', 'busy');
          upsertPending('正在上传学生答卷...', sessionId);
          const upload = await window.desktopApi.uploadImages({ filePaths: files });
          setPendingUploadId(sessionId, upload.upload_id);
          chatPayload.upload_id = upload.upload_id;
          const pageCount = pending?.page_count;
          if (pageCount && pageCount > 0) {
            const est = Math.floor(files.length / pageCount);
            const rem = files.length % pageCount;
            let hint = `已收到 ${files.length} 张照片（约 ${est} 份答卷，每份 ${pageCount} 页）`;
            if (rem !== 0) hint += `\n⚠️ 当前 ${files.length} 张不是 ${pageCount} 的整数倍，可能有遗漏。`;
            appendMessage({ sessionId, role: 'system', content: hint });
          } else {
            appendMessage({ sessionId, role: 'system', content: `已上传 ${files.length} 张学生答卷照片` });
          }
          appendMessage({ sessionId, role: 'system', content: '💡 请确保照片按学生顺序排列：学生1第1页→学生1第2页→学生2第1页→学生2第2页...' });
        }
        upsertPending('正在提交批改任务...', sessionId);
        const reply = await window.desktopApi.sendChat(chatPayload);
        await handleAgentReply(reply, sessionId, { userCreatedAt });
        return;
      }

      if (files.length > 0 && files.every((f) => /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(f))) {
        setStatusHint('上传附件中', 'busy');
        upsertPending('正在上传图片...', sessionId);
        const upload = await window.desktopApi.uploadImages({ filePaths: files });
        setPendingUploadId(sessionId, upload.upload_id);
        appendMessage({
          sessionId,
          role: 'system',
          content: `已上传图片，upload_id=${upload.upload_id}`,
        });

        if (!text) {
          clearPending();
          setStatusHint('图片已就绪', 'ok');
          appendMessage({
            sessionId,
            role: 'assistant',
            content:
              '图片已收到，暂未自动开始任何任务。你可以继续说“检查这篇英语作文的病句和拼写，并判断和当前主题是否匹配”，或“根据这张教材图生成 PPT”。',
          });
          return;
        }

        upsertPending('正在处理请求...', sessionId);
        const reply = await window.desktopApi.sendChat({
          message: text,
          session_id: sessionId,
          upload_id: upload.upload_id,
        });
        await handleAgentReply(reply, sessionId, { userCreatedAt });
        return;
      }

      if (files.length > 0) {
        throw new Error('当前仅支持图片用于 PPT，或 csv/xlsx/xls/图片用于成绩分析');
      }

      setStatusHint('思考中', 'busy');
      upsertPending('正在思考并调用主控 Agent...', sessionId);
      const pending = state.pendingAnswerKeys.get(sessionId);
      const quizResult = state.pendingQuizResults.get(sessionId);
      const reply = await window.desktopApi.sendChat({
        message: text,
        session_id: sessionId,
        upload_id: pendingUploadId || undefined,
        answer_key_id: pending?.answer_key_id,
        quiz_result_id: quizResult?.result_id,
      });
      await handleAgentReply(reply, sessionId, { userCreatedAt });
    } catch (err) {
      clearPending();
      setStatusHint('请求失败', 'error');
      appendMessage({
        sessionId,
        role: 'assistant',
        content: `操作失败：${err.message}`,
      });
    } finally {
      clearPending();
      setComposerBusy(false);
    }
  }

  async function setupFirstTime() {
    const inviteCode = ui.inviteInput.value.trim();
    const allowedRoot = ui.rootInput.value.trim();

    ui.setupError.textContent = '';
    if (!state.authenticated && !inviteCode) {
      ui.setupError.textContent = '首次配置需要填写邀请码。';
      return;
    }
    ui.setupBtn.disabled = true;
    setStatusHint('初始化中', 'busy');

    try {
      const snapshot = await window.desktopApi.bootstrap({
        inviteCode,
        serverUrl: DEFAULT_SERVER_URL,
        allowedRoot,
      });
      setHeader(snapshot);
      showSetup(false);
      state.sessions = [];
      state.activeSessionId = '';
      state.sessionMessages.clear();
      state.pendingUploads.clear();
      persistCaches();
      await fetchSessionsFromCloud();
      await ensureActiveSession();
      setStatusHint('Ready', snapshot?.device?.status === 'online' ? 'ok' : 'default');
    } catch (err) {
      setStatusHint('初始化失败', 'error');
      ui.setupError.textContent = err.message || '配置失败';
    } finally {
      ui.setupBtn.disabled = false;
    }
  }

  async function initSessionsAfterLogin() {
    if (!state.authenticated) {
      state.sessions = [];
      state.activeSessionId = '';
      state.sessionMessages.clear();
      state.pendingUploads.clear();
      renderSessionList();
      renderActiveSession();
      return;
    }

    const cachedSessions = state.sessions;
    renderSessionList();
    if (cachedSessions.length) {
      state.activeSessionId = cachedSessions[0].session_id;
      renderActiveSession();
    }

    try {
      const cloud = await fetchSessionsFromCloud();
      if (!cloud.length) {
        await createNewSession();
        return;
      }
      const target = state.activeSessionId || cloud[0].session_id;
      await openSession(target);
    } catch {
      if (!state.sessions.length) {
        await createNewSession();
      } else if (state.activeSessionId) {
        renderActiveSession();
      }
    }
  }

  async function init() {
    hydrateCaches();
    setMode('main');

    const snapshot = await window.desktopApi.getState();
    setHeader(snapshot);
    state.serverUrl = snapshot.server_url || DEFAULT_SERVER_URL;

    window.desktopApi.onDeviceStatus((payload) => {
      if (!payload) {
        return;
      }
      setDeviceBadge(payload.status || 'offline');
      if (payload.status === 'online') {
        setStatusHint('Ready', 'ok');
      } else if (payload.status === 'connecting') {
        setStatusHint('设备连接中', 'busy');
      } else if (payload.status === 'error') {
        setStatusHint('设备异常', 'error');
      }
    });

    if (!snapshot.authenticated) {
      showSetup(true);
      renderSessionList();
      state.activeSessionId = '__local__';
      appendMessage({
        sessionId: '__local__',
        role: 'system',
        content: '欢迎使用 SmartMarker。请先完成首次配置。',
        persist: false,
      });
      return;
    }

    showSetup(false);
    await initSessionsAfterLogin();
  }

  ui.newChatBtn.addEventListener('click', async () => {
    try {
      await createNewSession();
    } catch (err) {
      setStatusHint('新建会话失败', 'error');
      appendMessage({
        sessionId: state.activeSessionId || '__local__',
        role: 'assistant',
        content: `新建会话失败：${err.message}`,
      });
    }
  });

  ui.attachBtn.addEventListener('click', async () => {
    if (state.sending) {
      return;
    }
    const picked = await window.desktopApi.pickFiles();
    state.selectedFiles = picked || [];
    showSelectedFiles();
  });

  ui.sendBtn.addEventListener('click', () => {
    sendMessage();
  });

  ui.messageInput.addEventListener('compositionstart', () => {
    state.isComposing = true;
  });

  ui.messageInput.addEventListener('compositionend', () => {
    state.isComposing = false;
  });

  ui.messageInput.addEventListener('keydown', (event) => {
    const isImeComposing = Boolean(event.isComposing) || state.isComposing || event.keyCode === 229;
    if (event.key === 'Enter' && !event.shiftKey && !isImeComposing) {
      event.preventDefault();
      sendMessage();
    }
  });

  ui.pickRootBtn.addEventListener('click', async () => {
    const dir = await window.desktopApi.pickDirectory();
    if (dir) {
      ui.rootInput.value = dir;
    }
  });

  ui.setupBtn.addEventListener('click', () => {
    setupFirstTime();
  });

  ui.reopenSetupBtn.addEventListener('click', () => {
    showSetup(true);
    ui.setupError.textContent = '';
  });

  ui.clearHistoryBtn.addEventListener('click', async () => {
    if (!state.authenticated) {
      return;
    }
    const ok = window.confirm('将永久删除当前账号全部历史会话，且不可恢复。确定继续吗？');
    if (!ok) {
      return;
    }
    try {
      await window.desktopApi.clearSessions();
      state.sessions = [];
      state.activeSessionId = '';
      state.sessionMessages.clear();
      state.pptReasoningShown.clear();
      state.pendingUploads.clear();
      persistCaches();
      renderSessionList();
      renderActiveSession();
      await createNewSession();
      setStatusHint('历史已清空', 'ok');
    } catch (err) {
      appendMessage({
        sessionId: state.activeSessionId || '__local__',
        role: 'assistant',
        content: `清空历史失败：${err.message}`,
      });
      setStatusHint('清空失败', 'error');
    }
  });

  ui.logoutBtn.addEventListener('click', async () => {
    await window.desktopApi.logout();
    localStorage.removeItem(SESSION_INDEX_CACHE_KEY);
    localStorage.removeItem(SESSION_MESSAGE_CACHE_KEY);
    location.reload();
  });

  init().catch((err) => {
    setStatusHint('初始化失败', 'error');
    appendMessage({
      sessionId: '__local__',
      role: 'assistant',
      content: `初始化失败：${err.message}`,
      persist: false,
    });
  });
})();
