const { Client } = require('@notionhq/client');
require('dotenv').config();

const notion = new Client({ auth: process.env.NOTION_TOKEN });

async function find() {
  console.log('🔍 [검색 엔진] 워크스페이스 내의 모든 데이터베이스를 탐색 중...');
  try {
    const response = await notion.search({
      filter: {
        property: 'object',
        value: 'database'
      },
      sort: {
        direction: 'descending',
        timestamp: 'last_edited_time'
      }
    });

    console.log(`\n🎉 총 ${response.results.length}개의 데이터베이스가 발견되었습니다!\n`);
    response.results.forEach((db, i) => {
      const title = db.title?.[0]?.plain_text || '제목 없음';
      console.log(`[${i + 1}] DB 이름: "${title}"`);
      console.log(`    - ID: ${db.id}`);
      console.log(`    - 인라인 상태: ${db.is_inline}`);
      console.log(`    - 수정 일시: ${db.last_edited_time}`);
      console.log(`    - URL: ${db.url}`);
    });
  } catch (error) {
    console.error('❌ 검색 중 에러 발생:', error.message);
  }
}

find();
