process.env.TZ = 'Asia/Seoul'; // 프로세스 전체 타임존을 한국 서울 시간으로 강제 설정
const cron = require('node-cron');
const notionService = require('./services/notionService');
const analyzer = require('./services/analyzer');
const slackService = require('./services/slackService');
const supabaseService = require('./services/supabaseService');
const config = require('./config');
require('dotenv').config();

/**
 * 특정 날짜의 월과 주차 정보를 한글로 리턴합니다.
 * 예: 2026-06-01 -> { month: 6, week: 1 } (6월 1주차)
 */
function getMonthAndWeek(date) {
  const target = new Date(date);
  const day = target.getDay();
  const diff = target.getDate() - day + (day === 0 ? -6 : 1);
  const startOfWeek = new Date(target.setDate(diff));

  const year = startOfWeek.getFullYear();
  const month = startOfWeek.getMonth() + 1;
  
  const firstDayOfMonth = new Date(year, startOfWeek.getMonth(), 1);
  const firstDayWeekday = firstDayOfMonth.getDay();
  
  const offset = firstDayWeekday === 0 ? 6 : firstDayWeekday - 1;
  const days = startOfWeek.getDate() + offset - 1;
  const weekNum = Math.floor(days / 7) + 1;

  return { month, week: weekNum };
}

/**
 * 날짜 객체를 YYYY-MM-DD KST 형식으로 포맷팅합니다.
 */
function formatKstDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * KST (Asia/Seoul) 기준 현재 일시를 가져옵니다. (TZ 환경변수가 설정되어 있으므로 new Date()를 반환)
 */
function getKstDate() {
  return new Date();
}

/**
 * 특정 날짜 기준으로 지난주 날짜 범위(월~일)와 주차 정보를 추출합니다.
 */
function getReportDateRanges(todayDate = getKstDate()) {
  const lastWeekMonday = new Date(todayDate);
  const day = lastWeekMonday.getDay();
  const daysToMonday = day === 0 ? -13 : -day - 6;
  lastWeekMonday.setDate(lastWeekMonday.getDate() + daysToMonday);

  const lastWeekSunday = new Date(lastWeekMonday);
  lastWeekSunday.setDate(lastWeekSunday.getDate() + 6);

  const thisWeekMonday = new Date(lastWeekMonday);
  thisWeekMonday.setDate(thisWeekMonday.getDate() + 7);

  const format = (d) => formatKstDate(d);

  const lastWeekInfo = getMonthAndWeek(lastWeekMonday);
  const thisWeekInfo = getMonthAndWeek(todayDate);

  return {
    lastWeekMondayDate: format(lastWeekMonday),
    thisWeekMondayDate: format(thisWeekMonday),
    startDate: format(lastWeekMonday),
    endDate: format(lastWeekSunday),
    lastWeekTitle: `${lastWeekInfo.month}월 ${lastWeekInfo.week}주차`,
    nextWeekTitle: `${thisWeekInfo.month}월 ${thisWeekInfo.week}주차`
  };
}

/**
 * 매주 월요일 실행될 주간 보고 메인 파이프라인
 */
async function executeWeeklyPipeline() {
  console.log(`\n==================================================`);
  console.log(`🔔 [자동 스케줄 트리거] ${new Date().toLocaleString()} 주간 업무 보고 파이프라인 시작`);
  console.log(`==================================================`);
  
  const members = ['김윤회', '김희승', '최현빈'];
  
  const refDate = getKstDate();
  const day = refDate.getDay();
  // 금요일(5) 실행 시: 기준 날짜를 3일 더해 다음주 월요일로 만듦으로써,
  // getReportDateRanges가 "이번 주 월~일" 범위를 분석하도록 타겟팅을 통일합니다.
  if (day === 5) {
    refDate.setDate(refDate.getDate() + 3);
  }
  
  const { lastWeekMondayDate, thisWeekMondayDate, startDate, endDate, lastWeekTitle, nextWeekTitle } = getReportDateRanges(refDate);

  console.log("- 분석 대상 기간 (지난주 월~일): " + startDate + " ~ " + endDate);
  console.log("- 지난주 월요일 (Week Start): " + lastWeekMondayDate);
  console.log("- 이번 주 월요일 (Week Start): " + thisWeekMondayDate);

  const memberReports = [];

  for (const memberName of members) {
    console.log(`\n- [담당자: ${memberName} 님] 파이프라인 처리 중...`);
    try {
      // 1. 지난주 주간 계획 데이터 가져오기
      const weeklyPage = await notionService.getWeeklyPlanPage(lastWeekMondayDate, memberName);
      if (!weeklyPage) {
        console.warn(`  ⚠️ '${lastWeekMondayDate}' 계획을 찾을 수 없어 '${memberName}' 건은 건너뜁니다.`);
        continue;
      }

      // 2. 이번 주 신규 계획 정보 사전에 가져오기 (Tasks 정보 통합 매핑용)
      const nextWeeklyPage = await notionService.getWeeklyPlanPage(thisWeekMondayDate, memberName);
      if (nextWeeklyPage) {
        console.log(`  -> 이번 주 계획 페이지 검색 성공! (Page ID: ${nextWeeklyPage.id})`);
      }

      // 3. 지난주 일지 가져오기
      const dailyLogs = await notionService.getDailyWorkLogs(startDate, endDate, memberName);

      // 4. Tasks 맵 구성 (지난주 계획 + 이번주 계획 + 일지 연동 테스크 통합 수집)
      const taskIds = new Set();
      const weeklyRichText = weeklyPage.properties['할 일']?.rich_text || [];
      weeklyRichText.forEach(elem => {
        if (elem.type === 'mention' && elem.mention.type === 'page') {
          taskIds.add(elem.mention.page.id);
        }
      });

      if (nextWeeklyPage) {
        const nextWeeklyRichText = nextWeeklyPage.properties['할 일']?.rich_text || [];
        nextWeeklyRichText.forEach(elem => {
          if (elem.type === 'mention' && elem.mention.type === 'page') {
            taskIds.add(elem.mention.page.id);
          }
        });
      }

      dailyLogs.forEach(log => {
        log.taskRelations.forEach(rel => taskIds.add(rel.id));
      });
      
      const tasksMap = await notionService.getTasksMap(Array.from(taskIds));

      // 5. 완료 대조 분석
      const analysisResults = analyzer.analyzeWork(weeklyPage, dailyLogs, tasksMap);

      // 6. 노션 자동 완료 ✅ 및 멘션 Write-Back
      const updatedRichText = analyzer.buildUpdatedRichText(weeklyPage, analysisResults);
      await notionService.updateWeeklyPlanRichText(weeklyPage.id, updatedRichText);
      console.log(`  -> 노션 본문 완료 체크(✅) 및 멘션 업데이트 완료`);

      // 7. 이번 주 신규 계획 정보 파싱
      let nextWeekPlan = [];
      if (nextWeeklyPage) {
        nextWeekPlan = analyzer.analyzeWork(nextWeeklyPage, [], tasksMap);
      }

      memberReports.push({
        memberName,
        analysisResults,
        dailyLogs,
        nextWeekPlan,
        tasksMap
      });

    } catch (error) {
      console.error(`  ❌ '${memberName}' 님 파이프라인 구동 중 오류 발생:`, error.message);
    }
  }

  // 7. 채널 최종 취합 보고 발송 (#스마트팜-workplan)
  if (memberReports.length > 0) {
    try {
      console.log(`\n- '#스마트팜-workplan' 채널로 취합 격자 표 보고서 발송 중...`);
      const isNoticeSent = await slackService.sendWeeklyReport({
        weekTitle: lastWeekTitle,
        nextWeekTitle: nextWeekTitle,
        memberReports,
        targetChannelName: '주간업무보고',
        startDate,
        endDate
      });

      if (isNoticeSent) {
        console.log(`🎉 [성공] Slack 채널 주간 보고 취합 메시지 전송 성공!`);
      } else {
        console.error(`❌ [실패] Slack 메시지 전송 실패`);
      }
    } catch (error) {
      console.error(`❌ [에러] Slack 취합 공지 발송 오류:`, error.message);
    }
  } else {
    console.warn(`⚠️ 분석 성공한 데이터가 존재하지 않아 종합 공지 메시지를 전송하지 않았습니다.`);
  }
}

/**
 * 매일 실행될 일일 업무 보고 취합 및 DM 전송 파이프라인 (저녁 19:00 KST 가동)
 */
async function executeDailyPipeline() {
  const kstNow = getKstDate();
  const isMorning = kstNow.getHours() < 12;
  const modeStr = isMorning ? "오전 08:30 감시 모드" : "저녁 19:00 모드";

  console.log(`\n==================================================`);
  console.log(`🔔 [자동 일일 스케줄 트리거] ${new Date().toLocaleString()} 일일 업무 보고 파이프라인 시작 (${modeStr})`);
  console.log(`==================================================`);

  const members = ['김윤회', '김희승', '최현빈'];
  
  if (isMorning) {
    kstNow.setDate(kstNow.getDate() - 1);
    console.log(`- [오전 실행 감지] 전날(어제: ${formatKstDate(kstNow)}) 일일 보고서 최종 업데이트를 진행합니다.`);
  }

  const todayStr = formatKstDate(kstNow);

  let startDate = todayStr;
  let endDate = todayStr;

  const day = kstNow.getDay(); // 0: 일, 1: 월, 2: 화, 3: 수, 4: 목, 5: 금, 6: 토
  
  if (day === 1) {
    // 월요일 저녁: 지난 주말(토 ~ 일) 및 월요일 당일까지 포함하여 3일간 실적 수집
    const sat = new Date(kstNow);
    sat.setDate(kstNow.getDate() - 2);
    
    startDate = formatKstDate(sat);
    endDate = todayStr;
    console.log(`- 수집 모드: 월요일 저녁 주말 포함 실적 보고 (기간: ${startDate} ~ ${endDate})`);
  } else {
    // 화 ~ 금요일 저녁: 당일(오늘) 하루 실적 즉시 보고
    startDate = todayStr;
    endDate = todayStr;
    console.log(`- 수집 모드: 평일 저녁 당일 실적 보고 (오늘자: ${startDate})`);
  }

  // 주말 및 공휴일 검사
  const isWeekend = day === 0 || day === 6;
  const isHoliday = await supabaseService.checkIsHoliday(endDate);
  if (isWeekend || isHoliday) {
    console.log(`- ☕ 대상일자(${endDate})는 휴일(주말: ${isWeekend}, 공휴일: ${isHoliday})이므로 일일 업무 보고 파이프라인을 생략합니다.`);
    return;
  }

  const memberReports = [];

  for (const memberName of members) {
    console.log(`\n- [담당자: ${memberName} 님] 일일 실적 수집 중... (${startDate} ~ ${endDate})`);
    try {
      const dailyLogs = await notionService.getDailyWorkLogs(startDate, endDate, memberName);
      console.log(`  -> 일지 총 ${dailyLogs.length}개 수집 완료.`);

      const taskIds = new Set();
      dailyLogs.forEach(log => {
        log.taskRelations.forEach(rel => taskIds.add(rel.id));
      });
      const tasksMap = await notionService.getTasksMap(Array.from(taskIds));

      memberReports.push({
        memberName,
        dailyLogs,
        tasksMap
      });
    } catch (err) {
      console.error(`  ❌ '${memberName}' 님 일일 데이터 수집 중 오류:`, err.message);
    }
  }

  // 4단계: 기존 아카이브 파일 비교를 통한 업데이트 여부 감지
  const fs = require('fs');
  const path = require('path');
  const reportDir = path.join(__dirname, '../docs/daily-reports');
  const filename = `${endDate}.md`;
  const savePath = path.join(reportDir, filename);

  const currentMarkdown = await slackService.buildDailyReportMarkdown({
    date: endDate,
    memberReports
  });

  if (fs.existsSync(savePath)) {
    const existingMarkdown = fs.readFileSync(savePath, 'utf8');

    // 순수 텍스트 비교를 위해 URL의 쿼리 파라미터만 제거하고 비교하는 헬퍼
    const cleanForCompare = (str) => {
      return str
        .replace(/(https?:\/\/[^\s)>|?]+)\?[^\s)>|]*/g, '$1') // 모든 URL의 query string만 지우기 (만료 파라미터 차이 제거)
        .replace(/[\s\r\n]+/g, ' ') // 공백 및 줄바꿈 차이 일치화
        .trim();
    };

    if (cleanForCompare(currentMarkdown) === cleanForCompare(existingMarkdown)) {
      console.log(`\n==================================================`);
      console.log(`⏭️  [스킵] 오늘(${endDate})의 일일 업무 일지 변동 사항이 없습니다.`);
      console.log(`==================================================`);
      return;
    }
    console.log(`\n🔄 [변동 감지] 일지 보완(추가/수정)이 확인되어 슬랙 및 아카이브 갱신을 진행합니다.`);
  }

  // 5단계: '일일업무보고' 비공개 채널로 보고서 전송
  if (memberReports.length > 0) {
    try {
      const isNoticeSent = await slackService.sendDailyReport({
        date: endDate, // 보고서 상 날짜 라벨은 마지막 날짜 기준
        memberReports,
        targetChannelName: '일일업무보고'
      });
      if (isNoticeSent) {
        console.log(`🎉 [성공] 일일업무보고 채널로 일일 업무 보고서 발송 성공!`);
      } else {
        console.error(`❌ [실패] 일일 업무 보고서 발송 실패`);
      }
    } catch (err) {
      console.error(`❌ [에러] 일일 업무 보고서 발송 중 예외 발생:`, err.message);
    }
  } else {
    console.warn(`⚠️ 수집된 팀원 실적이 없어 보고를 생략합니다.`);
  }
}

/**
 * 매일 저녁 18:00 KST에 실행될 일지 작성 독려 파이프라인
 */
async function executeDailyReminderPipeline(targetDate = null) {
  console.log(`\n==================================================`);
  console.log(`🔔 [자동 일지 독려 트리거] ${new Date().toLocaleString()} 일지 작성 독려 파이프라인 시작 (대상일자: ${targetDate || '오늘'})`);
  console.log(`==================================================`);

  try {
    const kstNow = getKstDate();
    const todayStr = targetDate || formatKstDate(kstNow);
    const targetDateObj = targetDate ? new Date(targetDate) : kstNow;
    const day = targetDateObj.getDay();
    
    // 1. 주말 및 공휴일 검사
    const isWeekend = day === 0 || day === 6;
    const isHoliday = await supabaseService.checkIsHoliday(todayStr);
    if (isWeekend || isHoliday) {
      console.log(`  -> ☕ 대상일자(${todayStr})는 휴일(주말: ${isWeekend}, 공휴일: ${isHoliday})이므로 독려 메시지 발송을 생략합니다.`);
      return;
    }

    const members = ['김윤회', '김희승', '최현빈'];
    
    // 2. Supabase에서 오늘 휴가 및 출장 정보 가져오기
    const approvedLeaves = await supabaseService.getApprovedLeaves(todayStr);
    const approvedTrips = await supabaseService.getApprovedBusinessTrips(todayStr);

    for (const name of members) {
      const email = slackService.MEMBER_EMAILS[name];
      if (!email) continue;

      const leaveType = approvedLeaves[email];
      
      const tripInfo = approvedTrips.get(name);
      const isTrip = !!tripInfo;
      const isSmartFarmTrip = tripInfo ? tripInfo.isSmartFarm : false;

      // 연차, 반차, 공가 등 휴가상태이면 독려 제외
      if (leaveType) {
        console.log(`  -> 👤 ${name} 님: 휴가 상태 (${leaveType})로 판정되어 일지 독려에서 제외합니다.`);
        continue;
      }

      // 스마트팜 외 출장이면 독려 제외 (스마트팜 출장이면 일지 필수 작성)
      if (isTrip && !isSmartFarmTrip) {
        console.log(`  -> 👤 ${name} 님: 스마트팜 외 출장 상태로 판정되어 일지 독려에서 제외합니다.`);
        continue;
      }

      // 3. 노션 일지 조회
      const dailyLogs = await notionService.getDailyWorkLogs(todayStr, todayStr, name);
      const hasWrittenLog = dailyLogs && dailyLogs.length > 0;

      if (!hasWrittenLog) {
        const tripSuffix = isTrip ? ' (스마트팜 출장 중)' : '';
        console.log(`  -> 👤 ${name} 님: 오늘 일지 미작성 확인${tripSuffix}. 개인 독려 DM 발송 중...`);
        
        // 슬랙 멤버 ID 획득
        const slackUserId = await slackService.findUserIdByEmail(email);
        if (slackUserId) {
          const message = "일일 업무보고 작성시간 입니다 퇴근전에 작성 완료 부탁드립니다.";
          await slackService.sendDirectMessage(slackUserId, message);
          console.log(`    -> 🎉 ${name} 님에게 개인 독려 DM 발송 완료!`);
        } else {
          console.warn(`  ⚠️ ${name} 님의 슬랙 ID를 찾을 수 없어 독려 대상에서 제외합니다.`);
        }
      } else {
        console.log(`  -> 👤 ${name} 님: 일지 작성 완료.`);
      }
    }
  } catch (error) {
    console.error(`❌ 일지 작성 독려 파이프라인 중 오류 발생:`, error.message);
  }
}

/**
 * 매주 금요일 17:30에 차주 WeeklyPlan 미작성 멤버에게 개인 DM으로 작성 권장 메시지 전송
 */
async function executeWeeklyReminderPipeline() {
  console.log(`\n==================================================`);
  console.log(`🔔 [자동 주간계획 독려 트리거] ${new Date().toLocaleString()} 주간 계획 작성 독려 파이프라인 시작`);
  console.log(`==================================================`);

  try {
    const kstNow = getKstDate();
    const day = kstNow.getDay();

    // 1. 주말 및 공휴일 검사
    const todayStr = formatKstDate(kstNow);
    const isWeekend = day === 0 || day === 6;
    const isHoliday = await supabaseService.checkIsHoliday(todayStr);
    if (isWeekend || isHoliday) {
      console.log(`  -> ☕ 대상일자(${todayStr})는 휴일이므로 독려 메시지 발송을 생략합니다.`);
      return;
    }

    // 다음 주 월요일 날짜 계산 (금요일 기준 +3일)
    const nextWeekMondayObj = new Date(kstNow);
    nextWeekMondayObj.setDate(kstNow.getDate() + 3);
    const nextWeekMondayStr = formatKstDate(nextWeekMondayObj);
    console.log(`- 독려 대상 주간 계획 시작일 (다음 주 월요일): ${nextWeekMondayStr}`);

    const members = ['김윤회', '김희승', '최현빈'];

    for (const name of members) {
      const email = slackService.MEMBER_EMAILS[name];
      if (!email) continue;
      
      // 노션 주간 계획 조회
      const weeklyPage = await notionService.getWeeklyPlanPage(nextWeekMondayStr, name);
      
      // 주간 계획 작성 여부 판정
      let isPlanWritten = false;
      if (weeklyPage) {
        const richText = weeklyPage.properties['할 일']?.rich_text || [];
        isPlanWritten = richText.length > 0 && richText.some(elem => elem.plain_text && elem.plain_text.trim().length > 0);
      }

      if (!isPlanWritten) {
        console.log(`  -> 👤 ${name} 님: 다음 주 주간 계획 미작성 확인. 개인 독려 DM 발송 중...`);
        const slackUserId = await slackService.findUserIdByEmail(email);
        if (slackUserId) {
          const message = "다음 주 주간 계획(WeeklyPlan) 작성 부탁드립니다. 🙂";
          await slackService.sendDirectMessage(slackUserId, message);
          console.log(`    -> 🎉 ${name} 님에게 주간 계획 독려 DM 발송 완료!`);
        } else {
          console.warn(`  ⚠️ ${name} 님의 슬랙 ID를 찾을 수 없어 독려 대상에서 제외합니다.`);
        }
      } else {
        console.log(`  -> 👤 ${name} 님: 다음 주 주간 계획 작성 완료.`);
      }
    }
  } catch (error) {
    console.error(`❌ 주간 계획 작성 독려 파이프라인 중 오류 발생:`, error.message);
  }
}

/**
 * 진행률 100% 프로젝트 감지 및 완료 상태 싱크 파이프라인
 */
async function executeProjectStatusSyncPipeline() {
  console.log(`\n==================================================`);
  console.log(`🔔 [자동 스케줄 트리거] ${new Date().toLocaleString()} 프로젝트 진행 상황 싱크 시작`);
  console.log(`==================================================`);
  
  try {
    const completedList = await notionService.syncProjectStatuses();
    if (completedList.length > 0) {
      console.log(`-> 총 ${completedList.length}개의 프로젝트가 완료 처리되었습니다. 슬랙 알림 발송 중...`);
      for (const project of completedList) {
        await slackService.sendProjectCompletedNotification({
          projectName: project.name,
          projectUrl: project.url,
          pmName: project.pmName
        });
      }
    } else {
      console.log(`-> 완료 처리할 프로젝트가 없습니다.`);
    }
  } catch (error) {
    console.error(`❌ 프로젝트 싱크 파이프라인 실행 중 오류 발생:`, error.message);
  }
}

/**
 * 지연 태스크 독려 DM 알림 배치 파이프라인 (평일 오전 08:30)
 */
async function executeOverdueTasksReminderPipeline() {
  console.log(`\n==================================================`);
  console.log(`🔔 [자동 스케줄 트리거] ${new Date().toLocaleString()} 지연 태스크 알림 파이프라인 시작`);
  console.log(`==================================================`);
  
  try {
    const kstNow = getKstDate();
    const todayStr = formatKstDate(kstNow);
    const day = kstNow.getDay();

    // 1. 주말 및 공휴일 패스
    const isWeekend = day === 0 || day === 6;
    const isHoliday = await supabaseService.checkIsHoliday(todayStr);
    if (isWeekend || isHoliday) {
      console.log(`- ☕ 대상일자(${todayStr})는 휴일(주말: ${isWeekend}, 공휴일: ${isHoliday})이므로 지연 알림 발송을 생략합니다.`);
      return;
    }

    // 2. 지연 태스크 그룹 조회
    const overdueGroup = await notionService.getOverdueTasksByMember();
    
    // 3. 멤버별 독려 DM 순차 발송
    const memberNames = Object.keys(overdueGroup);
    if (memberNames.length === 0) {
      console.log(`-> 지연된 태스크를 가진 멤버가 없습니다.`);
      return;
    }

    const sentResults = [];

    for (const name of memberNames) {
      const group = overdueGroup[name];
      if (group.tasks.length > 0) {
        const success = await slackService.sendOverdueTasksReminder({
          memberName: name,
          position: group.position,
          tasks: group.tasks
        });
        if (success) {
          sentResults.push({
            name,
            position: group.position,
            count: group.tasks.length
          });
        }
      }
    }

    // 4. 정현웅(어드민) 님에게 발송 완료 요약 메시지 전송
    if (sentResults.length > 0) {
      let targetUserId = config.slack.adminUserId || 'U0B1U11SBE2';
      try {
        const { WebClient } = require('@slack/web-api');
        const userClient = new WebClient(config.slack.userToken);
        const authRes = await userClient.auth.test();
        if (authRes && authRes.user_id) {
          targetUserId = authRes.user_id;
        }
      } catch (authErr) {
        console.warn(`[지연 알림 어드민 공지] 유저 ID 동적 조회 실패 (백업 ID 사용):`, authErr.message);
      }

      let adminMsg = `📢 *[지연 태스크 독려 DM 발송 완료 안내]*\n`;
      adminMsg += `금일 팀원들에게 발송된 지연 태스크 독려 DM 내역입니다.\n\n`;
      sentResults.forEach(res => {
        adminMsg += `• *${res.name} ${res.position}* 님 : 지연 태스크 ${res.count}건 독려 완료\n`;
      });
      
      await slackService.sendDirectMessage(targetUserId, adminMsg);
      console.log(`  -> 🎉 정현웅 님에게 지연 태스크 독려 DM 발송 현황 요약 알림 전송 완료`);
    }
  } catch (error) {
    console.error(`❌ 지연 태스크 알림 파이프라인 에러:`, error.message);
  }
}

if (require.main === module) {
  // 주간보고 1차(금요일 18:10), 2차(금요일 21:00), 3차(금요일 23:00) 배치 가동
  cron.schedule('10 18,21,23 * * 5', () => {
    executeWeeklyPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  // 주간보고 최종 확정 (월요일 오전 08:30) 배치 가동
  cron.schedule('30 8 * * 1', () => {
    executeWeeklyPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  // 일일 업무보고 1차(18:10), 2차(21:00), 3차(23:00) (월~금요일) 배치 가동
  cron.schedule('10 18,21,23 * * 1-5', () => {
    executeDailyPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  // 일일 업무보고 익일 오전 08:30 감사 (화~토요일) 배치 가동
  cron.schedule('30 8 * * 2-6', () => {
    executeDailyPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  // 일일 일지 작성 독려 개인 DM 배치 가동 (평일 17:30)
  cron.schedule('30 17 * * 1-5', () => {
    executeDailyReminderPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  // 다음 주 주간 계획 작성 독려 개인 DM 배치 가동 (금요일 17:30)
  cron.schedule('30 17 * * 5', () => {
    executeWeeklyReminderPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  // 매시간 정각 프로젝트 자동 완료 처리 싱크 가동
  cron.schedule('0 * * * *', () => {
    executeProjectStatusSyncPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  // 평일(월~금요일) 오전 08:30 지연 태스크 독려 DM 배치 가동
  cron.schedule('30 8 * * 1-5', () => {
    executeOverdueTasksReminderPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  console.log('⏰ [스케줄러 대기 중] 일일/주간 보고 및 독려 자동 배치가 신규 스케줄 기준으로 정상 가동 대기 중입니다.');
}

module.exports = {
  getReportDateRanges,
  executeWeeklyPipeline,
  executeDailyPipeline,
  executeDailyReminderPipeline,
  executeWeeklyReminderPipeline,
  executeProjectStatusSyncPipeline,
  executeOverdueTasksReminderPipeline
};
