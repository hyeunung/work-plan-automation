/**
 * AI 일일 업무 보고 정리기 (Claude API)
 *
 * 두 가지 출력을 생성한다:
 *  A) organizeMemberLog  — 개별 팀원 일반 보고: 내용 누락 없이 전체를 구조화 (선임 상급자용, Slack mrkdwn)
 *  B) summarizeDailyReports — 요약 브리핑: 핵심을 전부 담아 간추린 비전문가용 요약 (대표이사용, GFM markdown)
 *
 * 호출 경로 (우선순위):
 *  1) ANTHROPIC_API_KEY 환경변수 존재 시 → 공식 @anthropic-ai/sdk (claude-opus-5)
 *  2) 없으면 → 로컬 Claude Code CLI (`claude -p`)
 * 둘 다 실패하면 에러를 던지고, 호출부(slackService)가 기존 원문 나열 방식으로 폴백한다.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 요약/정리에 사용할 모델. 품질을 올리고 싶으면 .env에 AI_SUMMARY_MODEL=claude-opus-5
const AI_MODEL = process.env.AI_SUMMARY_MODEL || 'claude-sonnet-5';

/** claude CLI 실행 파일 경로 탐색 (alias는 execFile에서 안 잡히므로 절대경로 폴백) */
function resolveClaudeCliPath() {
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    'claude',
  ].filter(Boolean);
  for (const p of candidates) {
    if (p === 'claude' || fs.existsSync(p)) return p;
  }
  return 'claude';
}

async function callViaSdk(prompt) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const stream = client.messages.stream({
    model: AI_MODEL,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error('AI 요청이 거부되었습니다 (refusal)');
  }
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

function callViaClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      resolveClaudeCliPath(),
      ['-p', '--output-format', 'text'],
      { timeout: 300000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env } },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`claude CLI 호출 실패: ${err.message} ${stderr || ''}`));
          return;
        }
        resolve(stdout);
      }
    );
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function callClaude(prompt) {
  let raw;
  if (process.env.ANTHROPIC_API_KEY) {
    raw = await callViaSdk(prompt);
  } else {
    raw = await callViaClaudeCli(prompt);
  }
  let result = raw.trim();
  result = result.replace(/^```(?:markdown|text)?\n?/, '').replace(/\n?```$/, '').trim();
  return result;
}

/* ============================================================
 * A) 일반 보고 정리 — 선임 상급자용, 내용 누락 금지, Slack mrkdwn
 * ============================================================ */
const ORGANIZE_PROMPT = `너는 스마트팜 개발팀의 업무 보고 비서다.
아래는 팀원이 노션에 작성한 업무 일지 한 건의 원문(줄 단위 나열)이다.
바로 위 선임 상급자가 보고받았을 때 알아듣기 편하도록, 원문을 구조화해서 다시 써라.

[절대 규칙]
- 내용을 빼먹으면 안 된다. 원문의 모든 사실·수치·부품명·판단·계획을 전부 담아라. 요약이 아니라 "정리"다.
- 원문에 없는 내용을 지어내지 않는다.
- "<URL|라벨>" 형태의 링크 토큰이 있으면 글자 하나 바꾸지 말고 그대로 유지한다.

[출력 형식 - Slack mrkdwn]
- 관련 있는 줄들을 작업 항목별로 묶어 "*1. 항목명*" 형태의 굵은 번호 제목을 붙인다 (굵게는 별표 1개: *텍스트*).
- 각 항목 아래에 "  - 내용" 형태의 하이픈 불릿으로 세부 내용을 쓴다. 원문 표현을 최대한 살리되 문장을 다듬는 것은 허용.
- 결론/판단/후속 조치가 있으면 "→"로 이어서 명확히 드러낸다.
- 마크다운 헤더(#), 별표 2개(**), 코드블록은 사용 금지. 전체 2,300자 이내.
- 위 형식의 본문만 출력한다. 서론/맺음말/설명 금지.

[일지 원문]
`;

/**
 * 일지 한 건의 상세 줄들을 구조화된 Slack mrkdwn 본문으로 정리.
 * @param {string} title 일지 제목
 * @param {string[]} detailLines formatLinksInText 처리된 상세 줄 배열
 * @returns {Promise<string>} 구조화된 본문 (제목 제외)
 */
async function organizeMemberLog(title, detailLines) {
  const body = `[일지 제목: ${title}]\n` + detailLines.map(l => `- ${l}`).join('\n');
  const result = await callClaude(ORGANIZE_PROMPT + body);
  if (!result || result.length < 10) {
    throw new Error('AI 정리 결과가 비어있습니다');
  }
  return result;
}

/* ============================================================
 * B) 요약 브리핑 — 대표이사용(비전문가), 핵심 전부 포함, GFM markdown
 * ============================================================ */
const SUMMARY_PROMPT = `너는 스마트팜 개발팀의 선임 상급자다.
아래는 팀원들이 노션에 작성한 당일 업무 일지의 원문 전문이다.
전문가가 아닌 대표이사에게 보고하는 요약 브리핑을 작성하라.

[절대 규칙]
- 간추리되 핵심 내용은 하나도 빠뜨리지 않는다: 한 일, 확인된 사실, 내린 결정, 발견된 문제, 다음 계획.
- 대표이사가 바로 이해하기 어려운 전문용어(예: RS485, FDR, PWM)만 "쉬운 말 풀이(원래 용어)" 형식으로 쓴다. 예: "통신 변환장치(RS485)", "토양수분센서(FDR)". PLC, 센서, 밸브처럼 업계에서 이미 널리 쓰여 대표이사도 알 만한 용어는 그대로 써도 된다 — 모든 용어를 다 쉽게 풀 필요는 없다. 풀어 쓰기로 한 용어는 쉬운 말만 쓰지 말고 원래 용어를 반드시 괄호로 남긴다.
- 수치는 의미가 전달되게 쓴다 (예: "변동폭이 기준의 6배 이상").
- 원문에 없는 내용을 지어내지 않는다.

[출력 형식 - 마크다운, 정확히 지킬 것]
### 👤 {이름} 님
* **{업무명 - 대표이사가 이해하기 쉬운 표현으로 다듬기 가능}**
  - {핵심 문장. 중요한 결론·수치는 **굵게**}
  - {문장 단위로 2~4개 불릿. 결정사항/문제/다음 단계가 있으면 반드시 포함}

- 팀원 순서와 업무는 원문 순서를 따른다. 일지가 없는 팀원은 쓰지 않는다.
- 위 형식의 마크다운만 출력한다. 서론/맺음말 금지.

[일지 원본]
`;

function buildSummaryInput(memberReports, dateLabel) {
  let body = `보고 대상 일자: ${dateLabel}\n\n`;
  for (const rep of memberReports) {
    if (!rep.dailyLogs || rep.dailyLogs.length === 0) continue;
    const cleanName = rep.memberName.replace(' 님', '').trim();
    body += `━━━ 팀원: ${cleanName} ━━━\n`;
    for (const log of rep.dailyLogs) {
      const cleanTitle = log.title ? log.title.replace(/[📄@]/g, '').trim() : '제목 없음';
      body += `\n[태스크: ${cleanTitle}]\n`;
      if (log.details && log.details.trim()) {
        const cleanedDetails = log.details
          .split('\n')
          .filter(line => !/https?:\/\/\S{120,}/.test(line))
          .join('\n');
        body += `${cleanedDetails.trim()}\n`;
      } else {
        body += `(본문 없음)\n`;
      }
    }
    body += `\n`;
  }
  return body;
}

/**
 * 팀 전체 일지를 대표이사용 요약 브리핑(GFM 마크다운 본문)으로 생성.
 * 반환 형식: "### 👤 이름 님\n* **업무명**\n  - 문장..." 섹션들
 */
async function summarizeDailyReports(memberReports, dateLabel) {
  const hasAnyLog = memberReports.some(rep => rep.dailyLogs && rep.dailyLogs.length > 0);
  if (!hasAnyLog) return '';

  const result = await callClaude(SUMMARY_PROMPT + buildSummaryInput(memberReports, dateLabel));

  if (!/^### 👤 .+ 님/m.test(result)) {
    throw new Error('AI 요약 결과가 기대 형식(### 👤 ... 님)과 다릅니다');
  }
  return result + '\n';
}

module.exports = { organizeMemberLog, summarizeDailyReports, callClaude };
