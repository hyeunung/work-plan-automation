const slackService = require('./src/services/slackService');
const notionService = require('./src/services/notionService');
const supabaseService = require('./src/services/supabaseService');
require('dotenv').config();

async function main() {
  console.log('--- 신규 채널 및 일일/주간보고 시뮬레이션 테스트 ---');
  
  const dailyChannelName = '일일업무보고';
  const weeklyChannelName = '주간업무보고';

  // 1. 채널 ID 조회 테스트
  const dailyChannelId = await slackService.findChannelIdByName(dailyChannelName);
  const weeklyChannelId = await slackService.findChannelIdByName(weeklyChannelName);

  console.log(`일일업무보고 채널 ID: ${dailyChannelId}`);
  console.log(`주간업무보고 채널 ID: ${weeklyChannelId}`);

  // 2. 스마트팜 관련 출장 데이터 판별 테스트 (5월 28일 기준 테스트)
  const date = '2026-05-28';
  console.log(`\n--- ${date} 출장 정보 조회 ---`);
  const trips = await supabaseService.getApprovedBusinessTrips(date);
  console.log('출장자 맵:', trips);

  // 3. 일일보고 테스트 발송
  console.log('\n--- 일일업무보고 발송 시뮬레이션 ---');
  const dummyMemberReports = [
    {
      memberName: '김윤회',
      dailyLogs: [],
      tasksMap: {}
    },
    {
      memberName: '김희승',
      dailyLogs: [],
      tasksMap: {}
    },
    {
      memberName: '최현빈',
      dailyLogs: [],
      tasksMap: {}
    }
  ];

  const dailyResult = await slackService.sendDailyReport({
    date: date,
    memberReports: dummyMemberReports,
    targetChannelName: dailyChannelName
  });
  console.log(`일일보고 발송 결과: ${dailyResult}`);

  // 4. 주간보고 테스트 발송 (실제 캔버스가 갱신되므로 알림 메시지만 테스트하거나 skipChannelNotice=false 로 테스트)
  console.log('\n--- 주간업무보고 발송 시뮬레이션 ---');
  const dummyWeeklyMemberReports = [
    {
      memberName: '김윤회',
      analysisResults: [],
      dailyLogs: [],
      nextWeekPlan: [],
      tasksMap: {}
    },
    {
      memberName: '김희승',
      analysisResults: [],
      dailyLogs: [],
      nextWeekPlan: [],
      tasksMap: {}
    },
    {
      memberName: '최현빈',
      analysisResults: [],
      dailyLogs: [],
      nextWeekPlan: [],
      tasksMap: {}
    }
  ];

  const weeklyResult = await slackService.sendWeeklyReport({
    weekTitle: '5월 4주차',
    nextWeekTitle: '6월 1주차',
    memberReports: dummyWeeklyMemberReports,
    targetChannelName: weeklyChannelName,
    startDate: '2026-05-25',
    endDate: '2026-05-31',
    skipChannelNotice: false // 알림 메시지 발송 여부
  });
  console.log(`주간보고 발송 결과: ${weeklyResult}`);
}

main().catch(err => {
  console.error('에러 발생:', err);
});
