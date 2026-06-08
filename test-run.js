process.env.TZ = 'Asia/Seoul';
const notionService = require('./src/services/notionService');
const analyzer = require('./src/services/analyzer');
const slackService = require('./src/services/slackService');
require('dotenv').config();

async function run() {
  console.log('🚀 [수동 즉각 테스트 실행] Notion & Slack 주간 업무보고 및 자동 ✅ 마킹 시스템 가동\n');

  const members = ['김윤회', '김희승', '최현빈'];
  
  const lastWeekMonday = '2026-05-26'; // 노션에 실제 5월 26일로 기입되어 있음
  const nextWeekMonday = '2026-06-01';

  const startDate = '2026-05-25';
  const endDate = '2026-05-31';

  const memberReports = [];

  for (const memberName of members) {
    console.log(`\n==================================================`);
    console.log(`👤 [담당자: ${memberName} 님] 분석 개시`);
    console.log(`==================================================`);

    try {
      // 1. 노션에서 지난주 주간 계획 데이터 가져오기 (Week Start 날짜로 조회)
      console.log(`[Step 1] 노션에서 '${memberName}' 담당자의 'Week Start: ${lastWeekMonday}' 페이지 조회 중...`);
      const weeklyPage = await notionService.getWeeklyPlanPage(lastWeekMonday, memberName);

      if (!weeklyPage) {
        console.warn(`  ⚠️ '${memberName}' 님의 '${lastWeekMonday}' 주간 계획을 찾을 수 없어 이번 건은 스킵합니다.`);
        continue;
      }
      console.log(`  -> 주간 계획 페이지 검색 성공! (Page ID: ${weeklyPage.id})`);

      // 2. 이번 주 업무 계획 데이터 가져오기 (사전 쿼리하여 Tasks 맵 조회에 Task ID 통합 반영)
      console.log(`[Step 2] 이번 주 계획 (Week Start: ${nextWeekMonday}) 페이지 조회 중...`);
      const nextWeeklyPage = await notionService.getWeeklyPlanPage(nextWeekMonday, memberName);
      if (nextWeeklyPage) {
        console.log(`  -> 이번 주 계획 페이지 검색 성공! (Page ID: ${nextWeeklyPage.id})`);
      } else {
        console.log(`  -> ⚠️ 이번 주 계획 페이지를 찾지 못했습니다.`);
      }

      // 3. 노션에서 지난주 Daily Work Log 및 관련 Tasks 가져오기
      console.log(`[Step 3] 지난주 (${startDate} ~ ${endDate}) 동안 작성된 Daily Work Log 조회 중...`);
      const dailyLogs = await notionService.getDailyWorkLogs(startDate, endDate, memberName);
      console.log(`  -> 총 ${dailyLogs.length}개의 일지 데이터를 수집했습니다.`);

      // 4. 연동된 Tasks 맵 구축 (지난주 계획 + 이번주 계획 + 일지 연동 테스크 통합 수집)
      console.log(`[Step 4] 일지들과 연동된 Tasks DB 맵 정보 조회 중...`);
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
      console.log(`  -> 총 ${Object.keys(tasksMap).length}개의 Tasks 상세 정보를 매핑했습니다.`);

      // 5. 계획 대비 완료/미완료 대조 분석 수행
      console.log(`[Step 5] 지난주 계획과 일지 실적 교차 대조 분석 중...`);
      const analysisResults = analyzer.analyzeWork(weeklyPage, dailyLogs, tasksMap);
      console.log('  -> 교차 대조 및 완료 여부 매핑 판정 완료!');

      // 6. 노션 본문(할 일 프로퍼티)에 ✅ 및 멘션 자동 마킹 수행 (Write-Back)
      console.log(`[Step 6] Notion 'Weekly Plan' 페이지에 자동 '✅' 및 멘션 업데이트 수행 중...`);
      const updatedRichText = analyzer.buildUpdatedRichText(weeklyPage, analysisResults);
      
      const isNotionUpdated = await notionService.updateWeeklyPlanRichText(weeklyPage.id, updatedRichText);
      if (isNotionUpdated) {
        console.log(`  -> 🎉 노션 본문에 완료 체크(✅) 및 일지 멘션 Write-Back 성공!`);
      } else {
        console.log(`  -> ⚠️ 노션 본문 업데이트가 생략되었거나 실패했습니다.`);
      }

      // 7. 이번 주 업무 계획 파싱 (이관 표시 및 독립 브리핑용)
      console.log(`[Step 7] 이번 주 계획 파싱 분석 중...`);
      let nextWeekPlan = [];
      if (nextWeeklyPage) {
        nextWeekPlan = analyzer.analyzeWork(nextWeeklyPage, [], tasksMap);
        console.log(`  -> 이번 주 계획 분석 성공!`);
      }

      // 수집 완료된 개별 직원의 분석 보고 데이터 적재
      memberReports.push({
        memberName,
        analysisResults,
        dailyLogs,
        nextWeekPlan,
        tasksMap
      });

    } catch (error) {
      console.error(`❌ ${memberName} 님 처리 중 에러 발생:`, error.message);
    }
  }

  // 7. 채널 최종 취합 보고 발송 (#스마트팜-workplan)
  if (memberReports.length > 0) {
    console.log(`\n==================================================`);
    console.log(`🚀 [Step 7] '#스마트팜-workplan' 채널로 최종 주간보고 표 취합 메시지 발송 중...`);
    console.log(`==================================================`);

    try {
      const isNoticeSent = await slackService.sendWeeklyReport({
        weekTitle: '5월 4주차',
        nextWeekTitle: '6월 1주차',
        memberReports,
        targetChannelName: '스마트팜-workplan',
        startDate,
        endDate,
        skipChannelNotice: true
      });

      if (isNoticeSent) {
        console.log(`\n✅ [성공] 모든 팀원의 노션 자동 마킹 및 슬랙 취합 3열 대조표 보고가 정상 완료되었습니다!`);
      } else {
        console.error(`\n❌ [실패] 슬랙 취합 보고서 전송 중 실패하였습니다.`);
      }
    } catch (error) {
      console.error(`\n❌ [에러] 슬랙 취합 보고서 전송 중 예외 발생:`, error.message);
    }
  } else {
    console.warn('\n⚠️ 데이터 수집에 성공한 팀원이 없어 슬랙 주간 보고를 생략합니다.');
  }
}

run();
