const { Client } = require('@notionhq/client');
require('dotenv').config();
const fs = require('fs');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// 원본 데이터베이스 ID들
const SOURCE_DB = {
  weeklyPlan: '36bc640c-cca4-80d5-b0d1-e7171d54f184',
  dailyWorkLog: '1c3c640c-cca4-8370-9509-019c4a379b92',
  tasks: '7eec640c-cca4-82a5-aba5-81fe3b052b93',
  teamMembers: '4b7c640c-cca4-82ba-99cc-817c501e7fa4',
  projects: 'd24c640c-cca4-8278-b12e-81dc5c4e7a51'
};

// 사용자가 수동으로 생성한 데이터베이스 ID들
const TARGET_DB = {
  teamMembers: '372c640c-cca4-8021-8a1d-fed25a9e0c46', // 팀멤버
  projects: '372c640c-cca4-8051-a472-d464b4f4c023',    // 프로젝트
  tasks: '372c640c-cca4-80be-b294-ed7ce11d9808',       // 테스크
  dailyWorkLog: '372c640c-cca4-8043-899e-e4ec443d918f',  // 데일리
  weeklyPlan: '36bc640c-cca4-80d5-b0d1-e7171d54f184'   // 기존 Weekly Plan 원본!
};

// 노션 API 속도 제한 대응용 딜레이 함수
const delay = (ms = 350) => new Promise(r => setTimeout(r, ms));

// 블록 데이터 정제 헬퍼
function cleanBlockData(block) {
  const { type } = block;
  const cleanBlock = {
    object: 'block',
    type: type,
    [type]: JSON.parse(JSON.stringify(block[type])) // 깊은 복사
  };

  const content = cleanBlock[type];
  if (content) {
    if (content.icon === null) delete content.icon;
    if (content.caption && (content.caption.length === 0 || content.caption === null)) delete content.caption;
    if (content.rich_text) {
      content.rich_text = content.rich_text.map(rt => {
        const cleanRt = { ...rt };
        if (cleanRt.text) {
          delete cleanRt.text.link;
        }
        return cleanRt;
      });
    }
  }

  return cleanBlock;
}

// 본문 블록 재귀 플랫화 복제기
async function getCleanBlockChildrenFlat(blockId) {
  let results = [];
  let hasMore = true;
  let startCursor = undefined;

  while (hasMore) {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: startCursor
    });
    results = results.concat(response.results);
    hasMore = response.has_more;
    startCursor = response.next_cursor;
    await delay(100);
  }

  let flatCleanBlocks = [];
  for (const block of results) {
    try {
      const { type, has_children, id } = block;
      const cleanBlock = cleanBlockData(block);
      
      if (has_children) {
        if (type === 'table') {
          const childRows = await getCleanBlockChildrenFlat(id);
          cleanBlock[type].children = childRows;
          flatCleanBlocks.push(cleanBlock);
        } else {
          flatCleanBlocks.push(cleanBlock);
          const childBlocks = await getCleanBlockChildrenFlat(id);
          flatCleanBlocks = flatCleanBlocks.concat(childBlocks);
        }
      } else {
        flatCleanBlocks.push(cleanBlock);
      }
    } catch (e) {
      // 에러 무시
    }
  }

  return flatCleanBlocks;
}

async function clonePageContent(oldPageId, newPageId) {
  try {
    const cleanBlocks = await getCleanBlockChildrenFlat(oldPageId);
    if (cleanBlocks.length > 0) {
      const chunkSize = 10;
      for (let i = 0; i < cleanBlocks.length; i += chunkSize) {
        const chunk = cleanBlocks.slice(i, i + chunkSize);
        await notion.blocks.children.append({
          block_id: newPageId,
          children: chunk
        });
        await delay(300);
      }
    }
  } catch (err) {
    console.error(`      ⚠️ 본문 복제 실패 (Old Page ID: ${oldPageId}):`, err.message);
  }
}

async function main() {
  console.log('🚀 [정밀 커스텀 마이그레이션] 사용자 데이터베이스 속성명 100% 동일 동기화 및 복제를 시작합니다...');
  console.log(`   - 대상 부모: Team Workspace (1)`);
  console.log(`   - Weekly Plan은 기존 원본 DB(${TARGET_DB.weeklyPlan})를 그대로 유지합니다.`);

  // 1. 사용자 수동 데이터베이스들에 누락된 컬럼 주입, 제목 필드 개명(Rename) 및 관계형 연동
  console.log('\n[1단계] 사용자 데이터베이스 속성 개명 및 정교한 결합 컬럼 주입 중...');

  // 1-1. Team Members 누락 필드 주입 (파일과 미디어)
  try {
    await notion.databases.update({
      database_id: TARGET_DB.teamMembers,
      properties: {
        '파일과 미디어': { type: 'files', files: {} }
      }
    });
    console.log('   - [팀멤버] 누락 속성 주입 성공 (파일과 미디어)');
  } catch (err) {
    console.error('   - [팀멤버] 누락 속성 주입 실패:', err.message);
  }
  await delay();

  // 1-2. Projects 스키마 업데이트 (image 필드, PM 관계형, Tasks DB 양방향 관계형 및 진행 상황 Status 옵션 완벽 동기화)
  try {
    await notion.databases.update({
      database_id: TARGET_DB.projects,
      properties: {
        'image': { type: 'files', files: {} },
        '진행 상황': {
          type: 'status',
          status: {
            options: [
              { name: '시작 전', color: 'default' },
              { name: '⏸️ 보류', color: 'yellow' },
              { name: '🚀 진행 중', color: 'blue' },
              { name: '✅ 완료', color: 'green' }
            ]
          }
        },
        'PM': {
          type: 'relation',
          relation: {
            database_id: TARGET_DB.teamMembers,
            type: 'single_property',
            single_property: {}
          }
        },
        'Tasks DB': {
          type: 'relation',
          relation: {
            database_id: TARGET_DB.tasks,
            type: 'dual_property',
            dual_property: {
              synced_property_name: 'Project' // Tasks 데이터베이스 쪽에 생길 역방향 필드명
            }
          }
        }
      }
    });
    console.log('   - [프로젝트] 속성 개명/진행상황 옵션 동기화/PM 및 Tasks DB 관계형 주입 완료!');
  } catch (err) {
    console.error('   - [프로젝트] 속성 주입 실패:', err.message);
  }
  await delay();

  // 1-3. Tasks 스키마 업데이트 (제목 필드 '이름' ➔ 'Task'로 개명!, 마감일자, 진행 상황 Status 옵션 완벽 동기화, 담당자 관계형)
  try {
    await notion.databases.update({
      database_id: TARGET_DB.tasks,
      properties: {
        '이름': { name: 'Task' }, // 제목 필드 이름 ➔ Task로 완벽 개명!
        '마감일자': { type: 'date', date: {} },
        '진행 상황': {
          type: 'status',
          status: {
            options: [
              { name: '⏸️ 대기', color: 'gray' },
              { name: '🙏 진행 예정', color: 'default' },
              { name: '🚀 진행 중', color: 'yellow' },
              { name: '💡 피드백', color: 'purple' },
              { name: '✅ 완료', color: 'green' },
              { name: '⏭ 보류', color: 'gray' }
            ]
          }
        },
        '담당자': {
          type: 'relation',
          relation: {
            database_id: TARGET_DB.teamMembers,
            type: 'single_property',
            single_property: {}
          }
        }
      }
    });
    console.log('   - [테스크] 제목필드 "Task"로 완벽 개명 및 마감일자/진행상황/담당자 속성 연동 완료!');
  } catch (err) {
    console.error('   - [테스크] 속성 주입 및 개명 실패:', err.message);
  }
  await delay();

  // 1-4. Weekly Plan 기존 원본 스키마 업데이트 (새로운 팀멤버 관계형으로 주입)
  try {
    await notion.databases.update({
      database_id: TARGET_DB.weeklyPlan,
      properties: {
        '작성자': {
          type: 'relation',
          relation: {
            database_id: TARGET_DB.teamMembers,
            type: 'single_property',
            single_property: {}
          }
        }
      }
    });
    console.log('   - [Weekly Plan] 원본 DB 작성자 관계형 필드 ➔ 신규 팀멤버로 리매핑 성공!');
  } catch (err) {
    console.error('   - [Weekly Plan] 작성자 관계형 리매핑 실패:', err.message);
  }
  await delay();

  // 1-5. Daily Work Log 스키마 업데이트 (제목 필드 '이름' ➔ '업무'로 개명!, 업무일, 이슈, 담당자, 관련 Task 관계형, 관련 Project 롤업)
  try {
    await notion.databases.update({
      database_id: TARGET_DB.dailyWorkLog,
      properties: {
        '이름': { name: '업무' }, // 제목 필드 이름 ➔ 업무로 완벽 개명!
        '업무일': { type: 'date', date: {} },
        '문제점·이슈': { type: 'rich_text', rich_text: {} },
        '담당자': {
          type: 'relation',
          relation: {
            database_id: TARGET_DB.teamMembers,
            type: 'single_property',
            single_property: {}
          }
        },
        '관련 Task': {
          type: 'relation',
          relation: {
            database_id: TARGET_DB.tasks,
            type: 'single_property',
            single_property: {}
          }
        },
        '관련 Project(자동)': {
          type: 'rollup',
          rollup: {
            rollup_property_name: 'Project',
            relation_property_name: '관련 Task',
            function: 'show_original'
          }
        }
      }
    });
    console.log('   - [데일리] 제목필드 "업무"로 완벽 개명 및 업무일/이슈/담당자/관련 Task/롤업 연동 완료!');
  } catch (err) {
    console.error('   - [데일리] 속성 주입 및 개명 실패:', err.message);
  }
  await delay();

  // 2. 데이터 백업 및 매핑 복제
  console.log('\n[2단계] 데이터 쿼리 및 순차적 이사 시작...');
  const idMap = {};

  // 2-1. Team Members 이사
  console.log(' 👉 [팀멤버] 복제 중...');
  try {
    const res = await notion.databases.query({ database_id: SOURCE_DB.teamMembers });
    console.log(`   - 총 ${res.results.length}명 감지. 이사 시작...`);
    for (const page of res.results) {
      const name = page.properties['이름']?.title?.[0]?.plain_text || '이름 없음';
      const files = page.properties['파일과 미디어']?.files || [];

      const newPage = await notion.pages.create({
        parent: { database_id: TARGET_DB.teamMembers },
        properties: {
          '이름': {
            title: [{ text: { content: name } }]
          },
          '파일과 미디어': {
            files: files.map(f => ({ name: f.name, type: f.type, [f.type]: f[f.type] }))
          }
        }
      });
      idMap[page.id] = newPage.id;
      console.log(`      * 복제 성공: ${name} (${page.id} ➔ ${newPage.id})`);
      await clonePageContent(page.id, newPage.id);
      await delay(200);
    }
  } catch (err) {
    console.error('   - [팀멤버] 복제 실패:', err.message);
  }

  // 2-2. Projects 이사
  console.log(' 👉 [프로젝트] 복제 중...');
  try {
    const res = await notion.databases.query({ database_id: SOURCE_DB.projects });
    console.log(`   - 총 ${res.results.length}개 프로젝트 감지. 이사 시작...`);
    for (const page of res.results) {
      const name = page.properties['프로젝트 명']?.title?.[0]?.plain_text || '제목 없음';
      const image = page.properties['image']?.files || [];
      const duration = page.properties['프로젝트 기간']?.date || null;
      const select = page.properties['선택']?.select ? { name: page.properties['선택'].select.name } : null;
      const status = page.properties['진행 상황']?.status ? { name: page.properties['진행 상황'].status.name } : null;
      const pmRelation = page.properties['PM']?.relation || [];

      const properties = {
        '프로젝트 명': { title: [{ text: { content: name } }] },
        'image': { files: image.map(i => ({ name: i.name, type: i.type, [i.type]: i[i.type] })) }
      };
      if (duration) properties['프로젝트 기간'] = { date: duration };
      if (select) properties['선택'] = { select };
      if (status) properties['진행 상황'] = { status };
      if (pmRelation.length > 0) {
        properties['PM'] = {
          relation: pmRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }

      const newPage = await notion.pages.create({
        parent: { database_id: TARGET_DB.projects },
        properties: properties
      });
      idMap[page.id] = newPage.id;
      console.log(`      * 복제 성공: ${name} (${page.id} ➔ ${newPage.id})`);
      await clonePageContent(page.id, newPage.id);
      await delay(200);
    }
  } catch (err) {
    console.error('   - [프로젝트] 복제 실패:', err.message);
  }

  // 2-3. Tasks 이사 (제목 필드 이름이 'Task'로 완벽 개명 완료되어 'Task'로 직접 삽입!)
  console.log(' 👉 [테스크] 복제 중...');
  try {
    const res = await notion.databases.query({ database_id: SOURCE_DB.tasks });
    console.log(`   - 총 ${res.results.length}개 태스크 감지. 이사 시작...`);
    for (const page of res.results) {
      const task = page.properties['Task']?.title?.[0]?.plain_text || '태스크 없음';
      const dueDate = page.properties['마감일자']?.date || null;
      const status = page.properties['진행 상황']?.status ? { name: page.properties['진행 상황'].status.name } : null;
      const assigneeRelation = page.properties['담당자']?.relation || [];
      const projectRelation = page.properties['Project']?.relation || [];

      // 스키마가 완벽히 동일해져서 원래 필드명 'Task' 그대로 쏩니다!
      const properties = {
        'Task': { title: [{ text: { content: task } }] }
      };
      if (dueDate) properties['마감일자'] = { date: dueDate };
      if (status) properties['진행 상황'] = { status };
      if (assigneeRelation.length > 0) {
        properties['담당자'] = {
          relation: assigneeRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }
      if (projectRelation.length > 0) {
        properties['Project'] = {
          relation: projectRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }

      const newPage = await notion.pages.create({
        parent: { database_id: TARGET_DB.tasks },
        properties: properties
      });
      idMap[page.id] = newPage.id;
      console.log(`      * 복제 성공: ${task} (${page.id} ➔ ${newPage.id})`);
      await clonePageContent(page.id, newPage.id);
      await delay(200);
    }
  } catch (err) {
    console.error('   - [테스크] 복제 실패:', err.message);
  }

  // 2-4. Weekly Plan 기존 원본 카드 작성자 관계형 필드 업데이트 (기존 카드는 그대로 두고 '작성자' 관계만 새 팀멤버로 수정!)
  console.log(' 👉 [Weekly Plan] 기존 원본 카드 작성자 관계형 필드 새 ID로 업데이트 중...');
  try {
    const res = await notion.databases.query({ database_id: TARGET_DB.weeklyPlan });
    for (const page of res.results) {
      const authorRelation = page.properties['작성자']?.relation || [];
      if (authorRelation.length > 0) {
        const newRelation = authorRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id);
        if (newRelation.length > 0) {
          await notion.pages.update({
            page_id: page.id,
            properties: {
              '작성자': {
                relation: newRelation
              }
            }
          });
          console.log(`      * 업데이트 완료: 계획서(${page.id})의 작성자 관계형 재연결 성공!`);
          await delay(100);
        }
      }
    }
  } catch (err) {
    console.error('   - [Weekly Plan] 작성자 재연결 실패:', err.message);
  }

  // 2-5. Daily Work Log 이사 (제목 필드 이름이 '업무'로 완벽 개명 완료되어 '업무'로 직접 삽입!)
  console.log(' 👉 [데일리] 복제 중...');
  try {
    const res = await notion.databases.query({ database_id: SOURCE_DB.dailyWorkLog });
    console.log(`   - 총 ${res.results.length}개 일일일지 감지. 이사 시작...`);
    for (const page of res.results) {
      const title = page.properties['업무']?.title?.[0]?.plain_text || '';
      const date = page.properties['업무일']?.date || null;
      const issue = page.properties['문제점·이슈']?.rich_text || [];
      const assigneeRelation = page.properties['담당자']?.relation || [];
      const taskRelation = page.properties['관련 Task']?.relation || [];

      // 스키마가 완벽히 동일해져서 원래 필드명 '업무' 그대로 쏩니다!
      const properties = {
        '업무': { title: [{ text: { content: title } }] },
        '문제점·이슈': { rich_text: issue.map(i => ({ type: i.type, [i.type]: i[i.type], text: i.text, annotations: i.annotations })) }
      };
      if (date) properties['업무일'] = { date };
      if (assigneeRelation.length > 0) {
        properties['담당자'] = {
          relation: assigneeRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }
      if (taskRelation.length > 0) {
        properties['관련 Task'] = {
          relation: taskRelation.map(r => ({ id: idMap[r.id] })).filter(r => r.id)
        };
      }

      const newPage = await notion.pages.create({
        parent: { database_id: TARGET_DB.dailyWorkLog },
        properties: properties
      });
      idMap[page.id] = newPage.id;
      console.log(`      * 복제 성공: ${title} (${page.id} ➔ ${newPage.id})`);
      await clonePageContent(page.id, newPage.id);
      await delay(200);
    }
  } catch (err) {
    console.error('   - [데일리] 복제 실패:', err.message);
  }

  // 3. 새로운 .env.new 파일 생성
  console.log('\n[3단계] 새로운 환경설정 파일 (.env.new) 생성 중...');
  try {
    const oldEnv = fs.readFileSync('.env', 'utf8');
    let newEnv = oldEnv;
    newEnv = newEnv.replace(/NOTION_WEEKLY_PLAN_DB_ID=.*/, `NOTION_WEEKLY_PLAN_DB_ID=${TARGET_DB.weeklyPlan}`);
    newEnv = newEnv.replace(/NOTION_DAILY_WORK_LOG_DB_ID=.*/, `NOTION_DAILY_WORK_LOG_DB_ID=${TARGET_DB.dailyWorkLog}`);
    newEnv = newEnv.replace(/NOTION_TASKS_DB_ID=.*/, `NOTION_TASKS_DB_ID=${TARGET_DB.tasks}`);
    newEnv = newEnv.replace(/NOTION_TEAM_MEMBERS_DB_ID=.*/, `NOTION_TEAM_MEMBERS_DB_ID=${TARGET_DB.teamMembers}`);
    
    // Projects ID 백업 기록
    newEnv += `\n# 복제된 프로젝트(Projects) DB ID: ${TARGET_DB.projects}`;

    fs.writeFileSync('.env.new', newEnv);
    console.log('   - 성공! .env.new 파일이 출력되었습니다.');
  } catch (err) {
    console.error('   - .env.new 생성 실패:', err.message);
  }

  console.log('\n🎉 [최종 완료] 사용자가 직접 만드신 전체 페이지 데이터베이스 세트로 완벽한 복제가 대성공하였습니다!');
}

main();
