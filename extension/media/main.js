(function () {
  const vscode = acquireVsCodeApi();

  const NODE_ORDER = [
    'normalize_request',
    'validate_request',
    'supervisor_route',
    'worker_generate',
    'tavily_search',
    'execute_sandbox',
    'compress_execution_output',
    'judge',
    'worker_repair',
    'escalation_or_failure',
  ];
  const NODE_LABEL = {
    normalize_request: 'normalize',
    validate_request: 'validate',
    supervisor_route: 'route',
    worker_generate: 'generate',
    tavily_search: 'search',
    execute_sandbox: 'execute',
    compress_execution_output: 'compress',
    judge: 'judge',
    worker_repair: 'repair',
    escalation_or_failure: 'escalate',
  };

  const connEl = document.getElementById('connState');
  const threadEl = document.getElementById('threadLabel');
  const authLabelEl = document.getElementById('authLabel');
  const authGateEl = document.getElementById('authGate');
  const signInBtn = document.getElementById('signInBtn');
  const signOutBtn = document.getElementById('signOutBtn');
  const traceEl = document.getElementById('trace');
  const codeEl = document.querySelector('#codeStream code');
  const compressionPanel = document.getElementById('compressionPanel');
  const compressionRows = document.getElementById('compressionRows');
  const finalOutputEl = document.getElementById('finalOutput');
  const form = document.getElementById('promptForm');
  const input = document.getElementById('promptInput');
  const sendBtn = document.getElementById('sendBtn');
  const newThreadBtn = document.getElementById('newThreadBtn');

  let repairAttempt = 0;
  let signedIn = false;

  function renderNodeBadges() {
    traceEl.innerHTML = '';
    for (const node of NODE_ORDER) {
      const badge = document.createElement('span');
      badge.className = 'node-badge';
      badge.dataset.node = node;
      badge.textContent = NODE_LABEL[node];
      traceEl.appendChild(badge);
    }
  }
  renderNodeBadges();

  function setActiveNode(node) {
    document.querySelectorAll('.node-badge').forEach((el) => {
      el.classList.toggle('active', el.dataset.node === node);
    });
  }

  function markJudgeVerdict(verdict) {
    const badge = traceEl.querySelector('[data-node="judge"]');
    if (!badge) return;
    badge.classList.remove('pass', 'fail');
    badge.classList.add(verdict === 'PASS' ? 'pass' : 'fail');
  }

  function setConnState(state) {
    connEl.textContent = state;
    connEl.className = 'pill ' + state;
  }

  function resetRun() {
    codeEl.textContent = '';
    finalOutputEl.textContent = '';
    finalOutputEl.className = '';
    compressionRows.innerHTML = '';
    compressionPanel.classList.add('hidden');
    repairAttempt = 0;
    document.querySelectorAll('.node-badge').forEach((el) => {
      el.classList.remove('active', 'pass', 'fail');
    });
    sendBtn.disabled = true;
    sendBtn.textContent = 'Running…';
  }

  function endRun() {
    sendBtn.disabled = !signedIn;
    sendBtn.textContent = 'Send';
  }

  function addCompressionRow(evt) {
    compressionPanel.classList.remove('hidden');
    const row = document.createElement('div');
    const saved = evt.input_tokens > 0
      ? Math.round((1 - evt.compressed_tokens / evt.input_tokens) * 100)
      : 0;
    row.innerHTML =
      '<span>' + evt.node_name + '</span>' +
      '<span>' + evt.input_tokens + ' → ' + evt.compressed_tokens + ' tok (' + saved + '% cut, ' + evt.latency_ms + 'ms)</span>';
    compressionRows.appendChild(row);
  }

  function handleInbound(payload) {
    switch (payload.type) {
      case 'status':
        setActiveNode(payload.node);
        if (payload.node === 'worker_repair') {
          const badge = traceEl.querySelector('[data-node="worker_repair"]');
          if (badge) badge.textContent = NODE_LABEL.worker_repair + ' (' + (++repairAttempt) + ')';
        }
        break;
      case 'code_chunk':
        codeEl.textContent += payload.content;
        break;
      case 'trace':
        if (payload.judge_verdict) markJudgeVerdict(payload.judge_verdict);
        break;
      case 'token_usage':
        addCompressionRow(payload);
        break;
      case 'final':
        finalOutputEl.textContent = payload.final_output;
        endRun();
        break;
      case 'failure': {
        const f = payload.failure_output;
        finalOutputEl.className = 'failed';
        finalOutputEl.textContent =
          'Failed after ' + f.attempts + ' attempt(s): ' + f.last_error +
          (f.partial_code ? '\n\n-- partial progress kept below --\n' + f.partial_code : '');
        endRun();
        break;
      }
      case 'error':
        finalOutputEl.className = 'failed';
        finalOutputEl.textContent = 'Error: ' + payload.message;
        endRun();
        break;
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.command) {
      case 'connectionState':
        setConnState(msg.state);
        break;
      case 'threadId':
        threadEl.textContent = 'thread: ' + msg.threadId.slice(0, 8);
        break;
      case 'inbound':
        handleInbound(msg.payload);
        break;
      case 'authState':
        applyAuthState(msg.signedIn, msg.email);
        break;
    }
  });

  function applyAuthState(isSignedIn, email) {
    signedIn = isSignedIn;
    authGateEl.classList.toggle('hidden', signedIn);
    signOutBtn.classList.toggle('hidden', !signedIn);
    input.disabled = !signedIn;
    sendBtn.disabled = !signedIn;
    authLabelEl.textContent = signedIn ? (email || 'signed in') : 'signed out';
  }

  signInBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'signIn' });
  });
  signOutBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'signOut' });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) return;
    resetRun();
    vscode.postMessage({ command: 'submitPrompt', prompt });
    input.value = '';
  });

  newThreadBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'newThread' });
  });

  vscode.postMessage({ command: 'ready' });
})();
