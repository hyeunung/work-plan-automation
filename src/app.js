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
 * 서버 타임존에 영향받지 않는 KST (Asia/Seoul) 기준 현재 일시를 가져옵니다.
 */
function getKstDate() {
  const utc = new Date().getTime() + (new Date().getTimezoneOffset() * 60000);
  const kst = new Date(utc + (9 * 60 * 60 * 1000));
  return kst;
}

/**
 * 특정 날짜 기준으로 지난주 날짜 범위(월~일)와 주차 정보를 추출합니다.
 */
function getReportDateRanges(todayDate = getKstDate()) {
  const lastWeekMonday = new Date(todayDate);
  const day = lastWeekMonday.getDay();
  const daysToMonday = day === 0 ? -13 : -day - 5;
  lastWeekMonday.setDate(lastWeekMonday.getDate() + daysToMonday);

  const lastWeekSunday = new Date(lastWeekMonday);
  lastWeekSunday.setDate(lastWeekSunday.getDate() + 6);

  const thisWeekMonday = new Date(lastWeekMonday);
  thisWeekMonday.setDate(thisWeekMonday.getDate() + 7);

  const format = (d) => d.toISOString().split('T')[0];

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
  const { lastWeekMondayDate, thisWeekMondayDate, startDate, endDate, lastWeekTitle, nextWeekTitle } = getReportDateRanges();

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
        targetChannelName: '스마트팜-workplan',
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
 * 매일 실행될 일일 업무 보고 취합 및 DM 전송 파이프라인
 * @param {boolean} isFridayNight 금요일 저녁 20:00 가동 여부
 */
async function executeDailyPipeline(isFridayNight = false) {
  console.log(`\n==================================================`);
  console.log(`🔔 [자동 일일 스케줄 트리거] ${new Date().toLocaleString()} 일일 업무 보고 파이프라인 시작 (금요일 저녁 모드: ${isFridayNight})`);
  console.log(`==================================================`);

  const members = ['김윤회', '김희승', '최현빈'];
  
  // 한국 시간(KST) 기준으로 오늘의 YYYY-MM-DD 날짜 추출
  const kstNow = getKstDate();
  const todayStr = kstNow.toISOString().split('T')[0];

  let startDate = todayStr;
  let endDate = todayStr;

  if (isFridayNight) {
    // 1. 금요일 저녁 20시 발송: 금요일 당일 하루 실적 수집
    startDate = todayStr;
    endDate = todayStr;
    console.log(`- 수집 모드: 금요일 당일 실적 즉시 보고 (${todayStr})`);
  } else {
    // 2. 평일 아침 08:30 발송: 전날 하루 실적 수집
    const day = kstNow.getDay(); // 0: 일, 1: 월, 2: 화, 3: 수, 4: 목, 5: 금, 6: 토
    
    if (day === 1) {
      // 월요일 아침: 지난 주말 (토 ~ 일) 2일간 실적 수집 (금요일은 금요일 저녁 8시에 이미 보고됨!)
      const sat = new Date(kstNow);
      sat.setDate(kstNow.getDate() - 2);
      const sun = new Date(kstNow);
      sun.setDate(kstNow.getDate() - 1);
      
      startDate = sat.toISOString().split('T')[0];
      endDate = sun.toISOString().split('T')[0];
      console.log(`- 수집 모드: 월요일 아침 주말 실적 보고 (기간: ${startDate} ~ ${endDate})`);
    } else if (day >= 2 && day <= 5) {
      // 화 ~ 금요일 아침: 전날(어제) 하루 실적 수집
      const yesterday = new Date(kstNow);
      yesterday.setDate(kstNow.getDate() - 1);
      
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      startDate = yesterdayStr;
      endDate = yesterdayStr;
      console.log(`- 수집 모드: 평일 아침 전날 실적 보고 (어제자: ${startDate})`);
    } else {
      // 주말 아침 (토, 일): 스케줄러상으로는 돌지 않으나, 수동 구동 등을 대비해 어제 하루로 폴백
      const yesterday = new Date(kstNow);
      yesterday.setDate(kstNow.getDate() - 1);
      
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      startDate = yesterdayStr;
      endDate = yesterdayStr;
      console.log(`- 수집 모드: 주말 아침 전날 실적 보고 (어제자: ${startDate})`);
    }
  }

  // 1단계: 대상 슬랙 유저 ID 동적 추출 (정현웅 님 ID)
  let targetUserId = config.slack.adminUserId || 'U0B1U11SBE2';
  try {
    const { WebClient } = require('@slack/web-api');
    const userClient = new WebClient(config.slack.userToken);
    const authRes = await userClient.auth.test();
    if (authRes && authRes.user_id) {
      targetUserId = authRes.user_id;
      console.log(`  -> [성공] 정현웅 님의 슬랙 ID 동적 확인 완료: ${authRes.user} (ID: ${targetUserId})`);
    }
  } catch (authErr) {
    console.warn(`  -> ⚠️ 유저 ID 동적 조회 실패 (백업 ID 사용):`, authErr.message);
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

  // 4단계: 1:1 HANSL 봇채팅방(DM)으로 보고서 전송
  if (memberReports.length > 0) {
    try {
      const isNoticeSent = await slackService.sendDailyReport({
        date: endDate, // 보고서 상 날짜 라벨은 마지막 날짜 기준
        memberReports,
        targetUserId
      });
      if (isNoticeSent) {
        console.log(`🎉 [성공] HANSL 봇채팅방으로 일일 업무 보고서 발송 성공!`);
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
    const todayStr = targetDate || kstNow.toISOString().split('T')[0];
    
    // 1. 공휴일 검사
    const isHoliday = await supabaseService.checkIsHoliday(todayStr);
    if (isHoliday) {
      console.log(`  -> ☕ 오늘은 공휴일(${todayStr})이므로 독려 메시지 발송을 생략합니다.`);
      return;
    }

    const members = ['김윤회', '김희승', '최현빈'];
    
    // 2. Supabase에서 오늘 휴가 및 출장 정보 가져오기
    const approvedLeaves = await supabaseService.getApprovedLeaves(todayStr);
    const approvedTrips = await supabaseService.getApprovedBusinessTrips(todayStr);

    const missingLogSlackIds = [];

    for (const name of members) {
      const email = slackService.MEMBER_EMAILS[name];
      if (!email) continue;

      const leaveType = approvedLeaves[email];
      const isTrip = approvedTrips.has(email);

      // 연차, 반차, 공가 등 휴가상태이면 독려 제외 (출장자는 제외 안됨!)
      if (leaveType) {
        console.log(`  -> 👤 ${name} 님: 휴가 상태 (${leaveType})로 판정되어 일지 독려에서 제외합니다.`);
        continue;
      }

      // 3. 노션 일지 조회
      const dailyLogs = await notionService.getDailyWorkLogs(todayStr, todayStr, name);
      const hasWrittenLog = dailyLogs && dailyLogs.length > 0;

      if (!hasWrittenLog) {
        const tripSuffix = isTrip ? ' (출장 중)' : '';
        console.log(`  -> 👤 ${name} 님: 오늘 일지 미작성 확인${tripSuffix}. 독려 대상 등록.`);
        
        // 슬랙 멤버 ID 획득
        const slackUserId = await slackService.findUserIdByEmail(email);
        if (slackUserId) {
          missingLogSlackIds.push(slackUserId);
        } else {
          console.warn(`  ⚠️ ${name} 님의 슬랙 ID를 찾을 수 없어 멘션 대상에서 제외합니다.`);
        }
      } else {
        console.log(`  -> 👤 ${name} 님: 일지 작성 완료.`);
      }
    }

    // 4. 채널로 일지 미작성자 독려 멘션 메시지 전송
    if (missingLogSlackIds.length > 0) {
      await slackService.sendChannelReminder({
        mentionIds: missingLogSlackIds,
        targetChannelName: '스마트팜-workplan'
      });
    } else {
      console.log(`  -> 🎉 오늘 모든 활동 근무자가 일지를 정상적으로 작성했습니다!`);
    }

  } catch (error) {
    console.error(`❌ 일지 작성 독려 파이프라인 중 오류 발생:`, error.message);
  }
}

if (require.main === module) {
  cron.schedule('0 8 * * 1', () => {
    executeWeeklyPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul" // 무조건 한국 서울 시간 기준으로 매주 월요일 오전 08:00에 칼같이 가동!
  });

  // 평일(월~금요일) 아침 08:30 (한국 시간 기준) 일일 업무 일지 봇채팅 전송 배치 가동
  cron.schedule('30 8 * * 1-5', () => {
    executeDailyPipeline(false);
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  // 평일(월~금요일) 저녁 18:00 (한국 시간 기준) 일지 작성 독려 멘션 배치 가동
  cron.schedule('0 18 * * 1-5', () => {
    executeDailyReminderPipeline();
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  // 금요일 저녁 20:00 (한국 시간 기준) 금요일 당일 업무 일지 봇채팅 즉시 전송 배치 가동
  cron.schedule('0 20 * * 5', () => {
    executeDailyPipeline(true);
  }, {
    scheduled: true,
    timezone: "Asia/Seoul"
  });

  console.log('⏰ [스케줄러 대기 중] 매주 월요일 오전 08:00 (주간보고), 월~금요일 오전 08:30 (일일보고), 월~금요일 저녁 18:00 (일지작성독려), 금요일 저녁 20:00 (금요 당일보고) 자동 배치가 가동 대기 중입니다.');
}

module.exports = {
  getReportDateRanges,
  executeWeeklyPipeline,
  executeDailyPipeline,
  executeDailyReminderPipeline
};
