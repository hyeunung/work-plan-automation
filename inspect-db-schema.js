const { Client } = require('@notionhq/client');
require('dotenv').config();
const fs = require('fs');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const dbIds = {
  weeklyPlan: '36bc640c-cca4-80d5-b0d1-e7171d54f184',
  dailyWorkLog: '1c3c640c-cca4-8370-9509-019c4a379b92',
  tasks: '7eec640c-cca4-82a5-aba5-81fe3b052b93',
  teamMembers: '4b7c640c-cca4-82ba-99cc-817c501e7fa4',
  projects: 'd24c640c-cca4-8278-b12e-81dc5c4e7a51' // 획득한 진짜 Projects DB ID
};

async function inspect() {
  const schemas = {};
  for (const [name, dbId] of Object.entries(dbIds)) {
    console.log(`🔍 [${name}] 데이터베이스 정보 조회 중 (${dbId})...`);
    try {
      const dbInfo = await notion.databases.retrieve({ database_id: dbId });
      schemas[name] = {
        id: dbId,
        title: dbInfo.title?.[0]?.plain_text || '제목 없음',
        is_inline: dbInfo.is_inline,
        properties: dbInfo.properties,
        parent: dbInfo.parent
      };
      console.log(`   - 성공: ${schemas[name].title} (is_inline: ${schemas[name].is_inline})`);
    } catch (err) {
      console.error(`   - 실패:`, err.message);
    }
  }

  // 부모 페이지 ce9c640c-cca4-839c-a2f2-01920e2e60ec 조회해보기
  try {
    const parentPage = await notion.pages.retrieve({ page_id: 'ce9c640c-cca4-839c-a2f2-01920e2e60ec' });
    console.log(`🔍 [Parent Page] 정보: ${parentPage.properties?.title?.title?.[0]?.plain_text || parentPage.properties?.Name?.title?.[0]?.plain_text || '제목 없음'}`);
  } catch (err) {
    console.error(`🔍 [Parent Page] 조회 실패:`, err.message);
  }

  fs.writeFileSync('db_schemas_debug.json', JSON.stringify(schemas, null, 2));
  console.log('🎉 모든 데이터베이스 스키마 조회가 완료되었으며, db_schemas_debug.json에 저장되었습니다.');
}

inspect();
