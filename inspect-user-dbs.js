const { Client } = require('@notionhq/client');
require('dotenv').config();

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const TARGET_DB = {
  teamMembers: '372c640c-cca4-8021-8a1d-fed25a9e0c46', // 팀멤버
  projects: '372c640c-cca4-8051-a472-d464b4f4c023',    // 프로젝트
  tasks: '372c640c-cca4-80be-b294-ed7ce11d9808',       // 테스크
  dailyWorkLog: '372c640c-cca4-8043-899e-e4ec443d918f'  // 데일리
};

async function inspect() {
  for (const [name, dbId] of Object.entries(TARGET_DB)) {
    console.log(`\n🔍 [${name}] DB 속성 정보 조회 중 (${dbId})...`);
    try {
      const dbInfo = await notion.databases.retrieve({ database_id: dbId });
      console.log(`   - DB 제목: "${dbInfo.title?.[0]?.plain_text || '제목 없음'}"`);
      console.log('   - 보유 중인 속성(Properties) 목록:');
      Object.entries(dbInfo.properties).forEach(([propName, propInfo]) => {
        console.log(`      * "${propName}" (타입: ${propInfo.type})`);
      });
    } catch (err) {
      console.error(`   - 조회 실패:`, err.message);
    }
  }
}

inspect();
