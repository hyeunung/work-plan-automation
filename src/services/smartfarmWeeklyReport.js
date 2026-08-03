/**
 * 스마트팜 주간업무 보고 파이프라인 (대표 보고용)
 *
 * 매주 월요일 아침 실행:
 *  1) 지난주(월~일) 세 팀원의 Notion Daily Work Log + 이번 주 Weekly Plan 수집
 *  2) docs/weekly-report-guide.md 지침을 그대로 프롬프트에 실어 Claude로 서술형 보고서 생성
 *  3) Slack 비공개 채널 #weekly-report 로 발송 + docs/smartfarm-weekly/ 에 아카이브
 *
 * 환경변수:
 *  - SLACK_WEEKLY_REPORT_CHANNEL_ID : 발송 채널 ID (기본 C0BLRVAGETS)
 *  - SMARTFARM_DRY_RUN=1            : 슬랙 발송 없이 콘솔 출력만 (로컬 테스트용)
 */
process.env.TZ = process.env.TZ || 'Asia/Seoul';
const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');
const config = require('../config');
const notionService = require('./notionService');
const aiSummarizer = require('./aiSummarizer');

const MEMBERS = ['김윤회', '최현빈', '김희승'];
const PART_MAP = { '김윤회': '무인대차 파트', '최현빈': '무인대차 파트', '김희승': '스마트팜 제어 파트' };
const REPORT_CHANNEL_ID = process.env.SLACK_WEEKLY_REPORT_CHANNEL_ID || 'C0BLRVAGETS';
const GUIDE_PATH = path.join(__dirname, '../../docs/weekly-report-guide.md');
const ARCHIVE_DIR = path.join(__dirname, '../../docs/smartfarm-weekly');

function formatKstDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function formatKorean(d) {
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function formatKoreanShort(d) {
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** 실행 시점 기준 지난주 월~일(데이터)과 월~금(표기), 이번 주 월~금 날짜 계산 */
function getWeekRanges(now = new Date()) {
  const daysSinceMonday = (now.getDay() + 6) % 7;
  const thisMonday = new Date(now);
  thisMonday.setHours(0, 0, 0, 0);
  thisMonday.setDate(thisMonday.getDate() - daysSinceMonday);

  const addDays = (base, n) => {
    const d = new Date(base);
    d.setDate(d.getDate() + n);
    return d;
  };

  const lastMonday = addDays(thisMonday, -7);
  return {
    lastMonday,
    lastFriday: addDays(lastMonday, 4),
    lastSunday: addDays(lastMonday, 6),
    thisMonday,
    thisFriday: addDays(thisMonday, 4)
  };
}

/** Weekly Plan 페이지의 '할 일' rich_text를 plain text로 병합 */
function extractPlanText(weeklyPage) {
  if (!weeklyPage) return '';
  const richText = weeklyPage.properties['할 일']?.rich_text || [];
  return richText.map(elem => elem.plain_text || '').join('').trim();
}

/** 수집 데이터를 AI 입력용 텍스트로 직렬화 */
function buildDataSection(memberData, ranges) {
  let body = '';
  for (const { name, logs, planText } of memberData) {
    body += `\n━━━ ${name} (${PART_MAP[name]}) ━━━\n`;
    body += `[지난주 일일 업무 일지: ${formatKstDate(ranges.lastMonday)} ~ ${formatKstDate(ranges.lastSunday)}]\n`;
    if (logs.length === 0) {
      body += '(일지 없음)\n';
    }
    for (const log of logs) {
      body += `\n(${log.date}) ${log.title}\n`;
      if (log.details && log.details.trim()) {
        const cleaned = log.details
          .split('\n')
          .filter(line => !/https?:\/\/\S{120,}/.test(line))
          .join('\n')
          .trim();
        if (cleaned) body += `${cleaned}\n`;
      }
    }
    body += `\n[이번 주 주간 계획 (Week Start ${formatKstDate(ranges.thisMonday)})]\n`;
    body += planText ? `${planText}\n` : '(계획 미등록 — 지난주 미완료 항목과 일지의 예정 업무로 계획을 구성할 것)\n';
  }
  return body;
}

function buildPrompt(guide, dataSection, ranges) {
  return `너는 스마트팜 개발팀의 선임 상급자다. 아래 [작성 지침]을 그대로 따라, 대표이사에게 보고할 "스마트팜 주간업무 보고"를 작성하라.

[작성 지침 전문]
${guide}

[이번 보고의 날짜 정보]
- 보고기간(지난주 월~금 표기): ${formatKorean(ranges.lastMonday)} ~ ${formatKoreanShort(ranges.lastFriday)}
- 이번 주 계획 기간: ${formatKorean(ranges.thisMonday)} ~ ${formatKoreanShort(ranges.thisFriday)}

[출력 규칙]
- 지침의 "보고서 형식"과 "체크리스트"를 전부 충족하는 보고서 본문만 출력한다. 서론·맺음말·설명·코드블록 금지.
- 볼드는 **...** (별표 2개), 전문 용어 설명은 "> " 인용 블록을 사용한다.
- 원문에 없는 내용을 지어내지 않는다.

[수집 데이터]
${dataSection}`;
}

/** GFM 마크다운 보고서를 Slack mrkdwn으로 변환 (**bold** -> *bold*) */
function toSlackMrkdwn(markdown) {
  return markdown.replace(/\*\*(.+?)\*\*/g, '*$1*');
}

async function executeSmartfarmWeeklyPipeline() {
  console.log(`\n==================================================`);
  console.log(`🔔 [자동 스케줄 트리거] ${new Date().toLocaleString()} 스마트팜 주간업무 보고(대표 보고용) 파이프라인 시작`);
  console.log(`==================================================`);

  const ranges = getWeekRanges();
  const startDate = formatKstDate(ranges.lastMonday);
  const endDate = formatKstDate(ranges.lastSunday);
  console.log(`- 데이터 수집 기간 (지난주 월~일): ${startDate} ~ ${endDate}`);
  console.log(`- 보고기간 표기 (지난주 월~금): ${formatKorean(ranges.lastMonday)} ~ ${formatKoreanShort(ranges.lastFriday)}`);

  // 1. Notion 데이터 수집
  const memberData = [];
  for (const name of MEMBERS) {
    console.log(`- [담당자: ${name} 님] 일지/계획 수집 중...`);
    const logs = await notionService.getDailyWorkLogs(startDate, endDate, name);
    const weeklyPage = await notionService.getWeeklyPlanPage(formatKstDate(ranges.thisMonday), name);
    const planText = extractPlanText(weeklyPage);
    console.log(`  -> 일지 ${logs.length}건, 이번 주 계획 ${planText ? '있음' : '없음'}`);
    memberData.push({ name, logs, planText });
  }

  const totalLogs = memberData.reduce((sum, m) => sum + m.logs.length, 0);
  if (totalLogs === 0) {
    console.warn('⚠️ 지난주 일지가 한 건도 없어 보고서 생성을 생략합니다.');
    return;
  }

  // 2. AI 보고서 생성
  const guide = fs.readFileSync(GUIDE_PATH, 'utf8');
  const prompt = buildPrompt(guide, buildDataSection(memberData, ranges), ranges);
  console.log(`- Claude로 보고서 생성 중...`);
  const report = await aiSummarizer.callClaude(prompt);

  if (!report.includes('스마트팜 주간업무 보고') || !report.includes('이상 보고 마치겠습니다')) {
    throw new Error('AI 보고서가 기대 형식(제목/맺음말)과 다릅니다. 발송을 중단합니다.');
  }
  console.log(`- 보고서 생성 완료 (${report.length}자)`);

  // 3. 아카이브 저장 (Actions의 커밋 스텝이 docs/ 를 자동 보존)
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archivePath = path.join(ARCHIVE_DIR, `${formatKstDate(ranges.thisMonday)}.md`);
  fs.writeFileSync(archivePath, report + '\n');
  console.log(`- 아카이브 저장 완료: ${archivePath}`);

  // 4. Slack 발송
  const slackText = toSlackMrkdwn(report);
  if (process.env.SMARTFARM_DRY_RUN === '1') {
    console.log(`\n--- [DRY RUN] 발송 생략, 보고서 미리보기 ---\n${slackText}\n--- [DRY RUN 끝] ---`);
    return;
  }

  const slack = new WebClient(config.slack.token);
  try {
    await slack.chat.postMessage({
      channel: REPORT_CHANNEL_ID,
      text: slackText,
      unfurl_links: false,
      unfurl_media: false
    });
    console.log(`🎉 [성공] #weekly-report (${REPORT_CHANNEL_ID}) 채널로 스마트팜 주간업무 보고 발송 완료!`);
  } catch (err) {
    if (err.data && (err.data.error === 'not_in_channel' || err.data.error === 'channel_not_found')) {
      throw new Error(`봇이 #weekly-report 비공개 채널에 초대되어 있지 않습니다. 채널에서 "/invite @봇이름" 으로 초대 후 재실행하세요. (원인: ${err.data.error})`);
    }
    throw err;
  }
}

module.exports = { executeSmartfarmWeeklyPipeline, getWeekRanges };
