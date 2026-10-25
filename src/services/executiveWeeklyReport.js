/**
 * 한슬 주간업무 보고 파이프라인 (대표 보고용)
 *
 * 매주 월요일 아침 실행:
 *  1) 지난주(월~일) Team Members DB 전원의 Notion Daily Work Log + 이번 주 Weekly Plan 수집
 *  2) 각 일지를 관련 Task → Project 로 묶어 "프로젝트 단위" 데이터로 정리
 *  3) docs/weekly-report-guide.md 지침을 그대로 프롬프트에 실어 Claude로 서술형 보고서 생성
 *  4) Slack 비공개 채널 #weekly-report 로 발송 + docs/executive-weekly/ 에 아카이브
 *
 * 보고 범위는 스마트팜에 국한하지 않고 한슬의 모든 업무다 (CLAUDE.md "보고 범위" 참조).
 *
 * 환경변수:
 *  - SLACK_WEEKLY_REPORT_CHANNEL_ID : 발송 채널 ID (기본 C0BLRVAGETS)
 *  - WEEKLY_REPORT_DRY_RUN=1        : 슬랙 발송 없이 콘솔 출력만 (로컬 테스트용)
 */
process.env.TZ = process.env.TZ || 'Asia/Seoul';
const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');
const config = require('../config');
const notionService = require('./notionService');
const aiSummarizer = require('./aiSummarizer');

const REPORT_TITLE = '한슬 주간업무 보고';
const CLOSING_LINE = '이상 보고 마치겠습니다';
const UNASSIGNED_PROJECT = '기타 업무';
const REPORT_CHANNEL_ID = process.env.SLACK_WEEKLY_REPORT_CHANNEL_ID || 'C0BLRVAGETS';
const GUIDE_PATH = path.join(__dirname, '../../docs/weekly-report-guide.md');
const ARCHIVE_DIR = path.join(__dirname, '../../docs/executive-weekly');
const DRY_RUN = process.env.WEEKLY_REPORT_DRY_RUN === '1' || process.env.SMARTFARM_DRY_RUN === '1';

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

/** 일지 본문에서 긴 URL 줄을 걷어내고 공백 정리 */
function cleanDetails(details) {
  if (!details || !details.trim()) return '';
  return details
    .split('\n')
    .filter(line => !/https?:\/\/\S{120,}/.test(line))
    .join('\n')
    .trim();
}

/**
 * 팀원별 일지를 프로젝트 단위로 재편한다.
 * 한 일지가 여러 프로젝트의 Task에 연결되어 있으면 각 프로젝트에 모두 포함한다.
 * 프로젝트가 없는 일지는 '기타 업무'로 묶는다.
 * 반환: 활동량(일지 수) 내림차순으로 정렬된 [{ name, category, members: [..], logs: [{ member, date, title, details }] }]
 */
function groupLogsByProject(memberData, tasksMap) {
  const groups = new Map();
  const ensure = (name, category) => {
    if (!groups.has(name)) {
      groups.set(name, { name, category: category || '', members: [], logs: [] });
    }
    return groups.get(name);
  };

  for (const { name: member, logs } of memberData) {
    for (const log of logs) {
      const projects = new Map();
      for (const rel of log.taskRelations || []) {
        const task = tasksMap[rel.id];
        if (task && task.projectName) {
          projects.set(task.projectName, task.projectCategory || '');
        }
      }
      if (projects.size === 0) projects.set(UNASSIGNED_PROJECT, '');

      for (const [projectName, category] of projects) {
        const group = ensure(projectName, category);
        if (!group.members.includes(member)) group.members.push(member);
        group.logs.push({ member, date: log.date, title: log.title, details: cleanDetails(log.details) });
      }
    }
  }

  const ordered = [...groups.values()].sort((a, b) => {
    // '기타 업무'는 항상 마지막, 나머지는 일지 수 내림차순 → 이름순
    if (a.name === UNASSIGNED_PROJECT) return 1;
    if (b.name === UNASSIGNED_PROJECT) return -1;
    return b.logs.length - a.logs.length || a.name.localeCompare(b.name, 'ko');
  });
  for (const group of ordered) {
    group.logs.sort((a, b) => a.date.localeCompare(b.date) || a.member.localeCompare(b.member, 'ko'));
  }
  return ordered;
}

/** 수집 데이터를 AI 입력용 텍스트로 직렬화 (A: 프로젝트별 일지, B: 팀원별 이번 주 계획) */
function buildDataSection(projectGroups, memberData, ranges) {
  let body = '';
  body += `[A. 지난주 프로젝트별 업무 일지: ${formatKstDate(ranges.lastMonday)} ~ ${formatKstDate(ranges.lastSunday)}]\n`;
  body += `(아래 프로젝트 순서 = 지난주 활동량 순. 보고서 섹션도 이 순서를 따른다.)\n`;
  projectGroups.forEach((group, idx) => {
    const categoryLabel = group.category ? ` / 분류: ${group.category}` : '';
    body += `\n━━━ 프로젝트 ${idx + 1}: ${group.name}${categoryLabel} / 담당: ${group.members.join(' · ')} ━━━\n`;
    for (const log of group.logs) {
      body += `\n(${log.date}) [${log.member}] ${log.title}\n`;
      if (log.details) body += `${log.details}\n`;
    }
  });

  body += `\n\n[B. 이번 주 주간 계획 (Week Start ${formatKstDate(ranges.thisMonday)}) - 팀원별 원문]\n`;
  body += `(계획 문장에 언급된 Task/프로젝트를 보고 A의 프로젝트 섹션에 맞춰 재배치할 것)\n`;
  for (const { name, planText } of memberData) {
    body += `\n━━━ ${name} ━━━\n`;
    body += planText
      ? `${planText}\n`
      : '(계획 미등록 — 지난주 미완료 항목과 일지의 예정 업무로 계획을 구성할 것)\n';
  }
  return body;
}

function buildPrompt(guide, dataSection, ranges) {
  return `너는 한슬 연구소의 선임 상급자다. 아래 [작성 지침]을 그대로 따라, 대표이사에게 구두 보고할 "${REPORT_TITLE}"를 작성하라.
보고 범위는 스마트팜에 한정되지 않는다. 수집 데이터에 등장하는 한슬의 모든 프로젝트와 업무를 같은 비중으로 다룬다.

[작성 지침 전문]
${guide}

[이번 보고의 날짜 정보]
- 보고기간(지난주 월~금 표기): ${formatKorean(ranges.lastMonday)} ~ ${formatKoreanShort(ranges.lastFriday)}
- 이번 주 계획 기간: ${formatKorean(ranges.thisMonday)} ~ ${formatKoreanShort(ranges.thisFriday)}

[출력 규칙]
- 지침의 "보고서 형식"과 "체크리스트"를 전부 충족하는 보고서 본문만 출력한다. 서론·맺음말·설명·코드블록 금지.
- 섹션은 수집 데이터 A의 프로젝트 순서대로 "N. 프로젝트명 (담당자 · 담당자)" 제목을 붙인다. 프로젝트를 임의로 합치거나 빼지 않는다.
- 볼드는 **...** (별표 2개), 전문 용어 설명은 "> " 인용 블록을 사용한다.
- 원문에 없는 내용을 지어내지 않는다.

[수집 데이터]
${dataSection}`;
}

/** GFM 마크다운 보고서를 Slack mrkdwn으로 변환 (**bold** -> *bold*) */
function toSlackMrkdwn(markdown) {
  return markdown.replace(/\*\*(.+?)\*\*/g, '*$1*');
}

async function executeExecutiveWeeklyPipeline() {
  console.log(`\n==================================================`);
  console.log(`🔔 [자동 스케줄 트리거] ${new Date().toLocaleString()} ${REPORT_TITLE}(대표 보고용) 파이프라인 시작`);
  console.log(`==================================================`);

  const ranges = getWeekRanges();
  const startDate = formatKstDate(ranges.lastMonday);
  const endDate = formatKstDate(ranges.lastSunday);
  console.log(`- 데이터 수집 기간 (지난주 월~일): ${startDate} ~ ${endDate}`);
  console.log(`- 보고기간 표기 (지난주 월~금): ${formatKorean(ranges.lastMonday)} ~ ${formatKoreanShort(ranges.lastFriday)}`);

  // 1. Notion 데이터 수집 (Team Members DB 전원)
  const members = await notionService.getTeamMemberNames();
  console.log(`- 보고 대상: ${members.join(', ')} (${members.length}명)`);
  const memberData = [];
  for (const name of members) {
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

  // 2. 일지 → 프로젝트 매핑 (관련 Task → Project)
  const taskIds = [...new Set(memberData.flatMap(m => m.logs.flatMap(log => (log.taskRelations || []).map(rel => rel.id))))];
  const tasksMap = taskIds.length > 0 ? await notionService.getTasksMap(taskIds) : {};
  const projectGroups = groupLogsByProject(memberData, tasksMap);
  console.log(`- 프로젝트 ${projectGroups.length}개로 정리: ${projectGroups.map(g => `${g.name}(${g.logs.length})`).join(', ')}`);

  // 3. AI 보고서 생성
  const guide = fs.readFileSync(GUIDE_PATH, 'utf8');
  const prompt = buildPrompt(guide, buildDataSection(projectGroups, memberData, ranges), ranges);
  console.log(`- Claude로 보고서 생성 중...`);
  const report = await aiSummarizer.callClaude(prompt);

  if (!report.includes(REPORT_TITLE) || !report.includes(CLOSING_LINE)) {
    throw new Error('AI 보고서가 기대 형식(제목/맺음말)과 다릅니다. 발송을 중단합니다.');
  }
  console.log(`- 보고서 생성 완료 (${report.length}자)`);

  // 4. DRY RUN 이면 아카이브·발송 없이 미리보기만 출력
  const slackText = toSlackMrkdwn(report);
  if (DRY_RUN) {
    console.log(`\n--- [DRY RUN] 아카이브·발송 생략, 보고서 미리보기 ---\n${slackText}\n--- [DRY RUN 끝] ---`);
    return;
  }

  // 5. 아카이브 저장 (Actions의 커밋 스텝이 docs/ 를 자동 보존)
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archivePath = path.join(ARCHIVE_DIR, `${formatKstDate(ranges.thisMonday)}.md`);
  fs.writeFileSync(archivePath, report + '\n');
  console.log(`- 아카이브 저장 완료: ${archivePath}`);

  // 6. Slack 발송

  const slack = new WebClient(config.slack.token);
  try {
    await slack.chat.postMessage({
      channel: REPORT_CHANNEL_ID,
      text: slackText,
      unfurl_links: false,
      unfurl_media: false
    });
    console.log(`🎉 [성공] #weekly-report (${REPORT_CHANNEL_ID}) 채널로 ${REPORT_TITLE} 발송 완료!`);
  } catch (err) {
    if (err.data && (err.data.error === 'not_in_channel' || err.data.error === 'channel_not_found')) {
      throw new Error(`봇이 #weekly-report 비공개 채널에 초대되어 있지 않습니다. 채널에서 "/invite @봇이름" 으로 초대 후 재실행하세요. (원인: ${err.data.error})`);
    }
    throw err;
  }
}

module.exports = {
  executeExecutiveWeeklyPipeline,
  /** @deprecated 구 파이프라인명. 'smartfarm-weekly' 트리거 호환용으로만 유지 */
  executeSmartfarmWeeklyPipeline: executeExecutiveWeeklyPipeline,
  getWeekRanges,
  groupLogsByProject
};
