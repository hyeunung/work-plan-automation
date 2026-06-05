const notionService = require('./src/services/notionService');
const slackService = require('./src/services/slackService');
const config = require('./src/config');
require('dotenv').config();

// CLI 인수 파싱
const args = process.argv.slice(2);
const isFridayMode = args.includes('--friday');
const isMorningMode = args.includes('--morning');

let dateArg = null;
const dateIndex = args.indexOf('--date');
if (dateIndex !== -1 && dateIndex + 1 < args.length) {
  dateArg = args[dateIndex + 1];
}

async function run() {
  console.log('🚀 [일일 보고 시뮬레이션 테스트 실행] Notion 일일 업무일지 수집 및 HANSL DM 전송 테스트\n');

  // 테스트 기준일자
  let startDate = '2026-05-28';
  let endDate = '2026-05-28';

  if (dateArg) {
    startDate = dateArg;
    endDate = dateArg;
    console.log(`- 📅 [수동 지정 날짜] 당일 실적 보고 (대상: ${startDate})`);
  } else if (isFridayMode) {
    // 금요일 당일 저녁 8시 모드 시뮬레이션: 금요일 당일 실적 수집
    startDate = '2026-05-28';
    endDate = '2026-05-28';
    console.log(`- 📅 [시뮬레이션: 금요일 저녁] 당일 실적 즉시 보고 (대상: ${startDate})`);
  } else if (isMorningMode) {
    // 평일 아침 8시 반 모드 시뮬레이션 (목요일 아침 가동이라 가정): 전날인 수요일 실적 수집
    startDate = '2026-05-27';
    endDate = '2026-05-27';
    console.log(`- 📅 [시뮬레이션: 평일 아침] 전날 실적 보고 (대상 어제자: ${startDate})`);
  } else {
    // 월요일 아침 8시 반 모드 시뮬레이션 (월요일 아침 가동이라 가정): 주말(토~일, 5월 26일~27일) 실적 수집
    startDate = '2026-05-26';
    endDate = '2026-05-27';
    console.log(`- 📅 [시뮬레이션: 월요일 아침] 주말 실적 보고 (기간: ${startDate} ~ ${endDate})`);
  }

  // 1단계: 정현웅 님 슬랙 User ID 동적 추출
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

  const members = ['김윤회', '김희승', '최현빈'];
  const memberReports = [];

  for (const memberName of members) {
    console.log(`\n==================================================`);
    console.log(`👤 [담당자: ${memberName} 님] 일일 실적 조회 (${startDate} ~ ${endDate})`);
    console.log(`==================================================`);

    try {
      // 2단계: Notion에서 지정일자 일지 가져오기
      const dailyLogs = await notionService.getDailyWorkLogs(startDate, endDate, memberName);
      console.log(`  -> 총 ${dailyLogs.length}개의 일지 데이터를 수집했습니다.`);

      // 3단계: 연동된 Tasks 맵 구성 (일지 관련 Task ID 수집)
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
      console.error(`  ❌ ${memberName} 님 일일 조회 실패:`, err.message);
    }
  }

  // 4단계: 1:1 HANSL 봇채팅방(DM)으로 보고서 전송
  console.log(`\n==================================================`);
  console.log(`🚀 HANSL 봇채팅방(DM)으로 일일 브리핑 메시지 전송 중...`);
  console.log(`==================================================`);

  if (memberReports.length > 0) {
    try {
      const isNoticeSent = await slackService.sendDailyReport({
        date: endDate,
        memberReports,
        targetUserId
      });
      if (isNoticeSent) {
        console.log(`\n✅ [성공] HANSL 봇채팅 1:1 DM으로 일일 업무 보고 브리핑이 정상 완료되었습니다!`);
      } else {
        console.error(`\n❌ [실패] DM 전송에 실패하였습니다.`);
      }
    } catch (err) {
      console.error(`\n❌ [에러] DM 전송 중 예외 발생:`, err.message);
    }
  } else {
    console.warn(`\n⚠️ 일지 데이터가 전혀 존재하지 않아 보고를 취소합니다.`);
  }
}

run();
