const notionService = require('./src/services/notionService');

async function run() {
  console.log('🔄 실시간 노션 지연 태스크 수집 및 상세 출력 중...');
  const overdueGroup = await notionService.getOverdueTasksByMember();
  
  console.log('JSON_OUTPUT_START');
  console.log(JSON.stringify(overdueGroup, null, 2));
  console.log('JSON_OUTPUT_END');
}

run();
