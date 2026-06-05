const { Client } = require('@notionhq/client');
require('dotenv').config();

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function debug() {
  console.log('🔍 [Weekly Plan DB 디버깅] 데이터베이스 항목 10개 조회 중...');
  try {
    const response = await notion.databases.query({
      database_id: '36bc640c-cca4-80d5-b0d1-e7171d54f184',
      page_size: 10
    });

    console.log(`조회 성공! 총 ${response.results.length}개의 항목이 있습니다.`);
    response.results.forEach((page, index) => {
      const title = page.properties['...']?.title?.[0]?.plain_text || '제목 없음';
      const weekStartDate = page.properties['Week Start']?.date?.start || '날짜 없음';
      const authorRelation = page.properties['작성자']?.relation || [];
      console.log(`[${index + 1}] Page ID: ${page.id}`);
      console.log(`    - 제목: ${title}`);
      console.log(`    - Week Start: ${weekStartDate}`);
      console.log(`    - 작성자 (Relation): ${JSON.stringify(authorRelation)}`);
    });

    console.log('\n🔍 [Tasks DB 디버깅] Tasks 데이터베이스 속성(Properties) 조회 중...');
    const tasksDbResponse = await notion.databases.retrieve({
      database_id: '7eec640c-cca4-82a5-aba5-81fe3b052b93'
    });
    console.log('Tasks DB 속성 목록:', Object.keys(tasksDbResponse.properties));
    
    // 항목 1개 꺼내어 세부 값 확인
    const tasksQuery = await notion.databases.query({
      database_id: '7eec640c-cca4-82a5-aba5-81fe3b052b93',
      page_size: 1
    });
    if (tasksQuery.results.length > 0) {
      console.log('Task 예시 항목 데이터:', JSON.stringify(tasksQuery.results[0].properties, null, 2));
    }

  } catch (error) {
    console.error('디버그 에러:', error);
  }
}

debug();
