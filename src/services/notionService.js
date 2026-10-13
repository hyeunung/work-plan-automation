const { Client } = require('@notionhq/client');
const config = require('../config');

const notion = new Client({ auth: config.notion.token });

/**
 * Notion 페이지의 제목을 슬러그화하여 슬랙 등의 외부 필터에서 경고가 발생하지 않는 예쁜 URL을 수동으로 조립합니다.
 */
function formatNotionPageUrl(title, id) {
  if (!id) return '';
  const cleanId = id.replace(/-/g, '');
  const slug = title
    .toString()
    .replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ\s-]/g, '') // 특수문자 및 기호 소거 (한글, 영문, 숫자, 공백 보존)
    .trim()
    .replace(/[\s_]+/g, '-')                      // 공백/밑줄을 하이픈으로 대체
    .replace(/-+/g, '-')                          // 중복 하이픈 축약
    .toLowerCase();
  
  return slug ? `https://www.notion.so/${slug}-${cleanId}` : `https://www.notion.so/${cleanId}`;
}

/**
 * Team Members DB의 전체 인원을 조회합니다. (보고·독려 대상 = Team Members 전원)
 * 반환: [{ id, name, position }] (config.notion.memberOrder 순서, 그 외 인원은 가나다순으로 뒤에)
 */
let teamMembersCache = null;

async function getTeamMembers() {
  if (teamMembersCache) return teamMembersCache;
  const members = [];
  let startCursor;
  do {
    const response = await notion.databases.query({
      database_id: config.notion.db.teamMembers,
      start_cursor: startCursor
    });
    for (const page of response.results) {
      const name = page.properties['이름']?.title?.map(t => t.plain_text).join('').trim();
      if (!name) continue;
      members.push({
        id: page.id,
        name,
        position: page.properties['직급']?.select?.name || ''
      });
    }
    startCursor = response.has_more ? response.next_cursor : undefined;
  } while (startCursor);

  const order = config.notion.memberOrder || [];
  const rank = name => (order.includes(name) ? order.indexOf(name) : order.length);
  members.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'ko'));
  teamMembersCache = members;
  return members;
}

async function getTeamMemberNames() {
  const members = await getTeamMembers();
  return members.map(m => m.name);
}

async function findTeamMember(memberName) {
  const members = await getTeamMembers();
  const cleanName = memberName.replace(' 님', '').trim();
  return members.find(m => m.name === cleanName) || null;
}

const notionUserNameCache = {};

async function getNotionUserName(userId) {
  if (userId in notionUserNameCache) return notionUserNameCache[userId];
  try {
    const user = await notion.users.retrieve({ user_id: userId });
    notionUserNameCache[userId] = user.name || '';
  } catch (error) {
    console.warn(`노션 사용자(${userId}) 조회 실패:`, error.message);
    notionUserNameCache[userId] = '';
  }
  return notionUserNameCache[userId];
}

/**
 * 특정 월요일 시작 날짜 및 담당자에 대한 Weekly Plan 페이지를 가져옵니다.
 * @param {string} weekMondayDate YYYY-MM-DD 형식의 월요일 날짜
 * @param {string} memberName 담당자 이름
 */
async function getWeeklyPlanPage(weekMondayDate, memberName) {
  try {
    // 1. Weekly Plan DB에서 Week Start 날짜만으로 우선 모든 주간 계획 목록 가져오기
    const weeklyResponse = await notion.databases.query({
      database_id: config.notion.db.weeklyPlan,
      filter: {
        property: 'Week Start',
        date: {
          equals: weekMondayDate
        }
      }
    });

    if (weeklyResponse.results.length === 0) {
      return null;
    }

    // 2. 작성자 프로퍼티(Relation 또는 People)로 담당자 페이지 매칭
    const member = await findTeamMember(memberName);
    for (const page of weeklyResponse.results) {
      const creatorProp = page.properties['작성자'] || page.properties['VRQP'];
      if (!creatorProp) continue;
      if (creatorProp.type === 'people' && creatorProp.people?.length > 0) {
        if (creatorProp.people.some(person => person.name && person.name.trim() === memberName.trim())) return page;
      } else if (creatorProp.type === 'relation' && creatorProp.relation?.length > 0 && member) {
        if (creatorProp.relation.some(rel => rel.id === member.id)) return page;
      }
    }

    // 3. 작성자 프로퍼티가 비어 있는 경우: 노션 페이지 생성자(created_by) 이름으로 매칭
    for (const page of weeklyResponse.results) {
      const creatorProp = page.properties['작성자'] || page.properties['VRQP'];
      const hasCreator = creatorProp && (creatorProp.people?.length > 0 || creatorProp.relation?.length > 0);
      if (hasCreator || !page.created_by?.id) continue;
      const creatorName = await getNotionUserName(page.created_by.id);
      if (creatorName && creatorName.trim() === memberName.trim()) {
        console.log(`  -> [생성자 매칭] '${memberName}' 님의 작성자 정보가 비어 있어 페이지 생성자 기준으로 매칭했습니다.`);
        return page;
      }
    }

    // 다른 사람의 계획을 잘못 매칭하지 않도록, 확실한 근거가 없으면 미작성으로 처리
    return null;
  } catch (error) {
    console.error('getWeeklyPlanPage 에러:', error);
    throw error;
  }
}

/**
 * 특정 기간 내에 특정 담당자가 작성한 Daily Work Log들을 가져옵니다.
 */
async function getDailyWorkLogs(startDate, endDate, memberName) {
  try {
    // 1. Team Members DB에서 memberName 페이지 ID 조회
    const member = await findTeamMember(memberName);
    if (!member) {
      throw new Error(`담당자 '${memberName}'를 찾을 수 없습니다.`);
    }
    const memberPageId = member.id;

    // 2. Daily Work Log DB에서 기간 및 담당자 필터링하여 조회
    const logResponse = await notion.databases.query({
      database_id: config.notion.db.dailyWorkLog,
      filter: {
        and: [
          {
            property: '업무일',
            date: {
              on_or_after: startDate
            }
          },
          {
            property: '업무일',
            date: {
              on_or_before: endDate
            }
          },
          {
            property: '담당자',
            relation: {
              contains: memberPageId
            }
          }
        ]
      },
      sorts: [
        {
          property: '업무일',
          direction: 'ascending'
        }
      ]
    });

    const logs = [];
    for (const page of logResponse.results) {
      const title = page.properties['업무']?.title?.[0]?.plain_text || '';
      const date = page.properties['업무일']?.date?.start || '';
      const taskRelations = page.properties['관련 Task']?.relation || [];
      const pageId = page.id;
      // 노션 페이지 생성 일시 (사후 작성/지연 작성 판별용, ISO 문자열)
      const createdTime = page.created_time || page.properties['생성 일시']?.created_time || '';

      const details = await getPageContentDetails(pageId);

      logs.push({
        pageId,
        title,
        date,
        createdTime,
        taskRelations,
        details,
        url: formatNotionPageUrl(title, pageId)
      });
    }

    return logs;
  } catch (error) {
    console.error('getDailyWorkLogs 에러:', error);
    throw error;
  }
}

/**
 * 노션 페이지 본문 내용을 재귀적으로 탐색하여 텍스트로 합산합니다.
 */
async function getPageContentDetails(blockId) {
  let textDetails = '';
  try {
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const response = await notion.blocks.children.list({
        block_id: blockId,
        start_cursor: startCursor
      });

      for (const block of response.results) {
        let blockText = '';
        if (block.type === 'paragraph' && block.paragraph.rich_text) {
          blockText = block.paragraph.rich_text.map(t => t.plain_text).join('');
        } else if (block.type === 'bulleted_list_item' && block.bulleted_list_item.rich_text) {
          blockText = block.bulleted_list_item.rich_text.map(t => t.plain_text).join('');
        } else if (block.type === 'numbered_list_item' && block.numbered_list_item.rich_text) {
          blockText = block.numbered_list_item.rich_text.map(t => t.plain_text).join('');
        } else if (block.type === 'to_do' && block.to_do.rich_text) {
          blockText = block.to_do.rich_text.map(t => t.plain_text).join('');
        } else if (block.type === 'heading_1' && block.heading_1.rich_text) {
          blockText = block.heading_1.rich_text.map(t => t.plain_text).join('');
        } else if (block.type === 'heading_2' && block.heading_2.rich_text) {
          blockText = block.heading_2.rich_text.map(t => t.plain_text).join('');
        } else if (block.type === 'heading_3' && block.heading_3.rich_text) {
          blockText = block.heading_3.rich_text.map(t => t.plain_text).join('');
        } else if (block.type === 'image' && block.image) {
          const caption = block.image.caption?.map(t => t.plain_text).join('') || '';
          const url = block.image.file?.url || block.image.external?.url || '';
          const label = caption ? `이미지 첨부: ${caption}` : '이미지 첨부';
          blockText = url ? `[${label}](${url})` : `[${label}]`;
        } else if (block.type === 'file' && block.file) {
          const caption = block.file.caption?.map(t => t.plain_text).join('') || '';
          const name = block.file.name || '';
          const url = block.file.file?.url || block.file.external?.url || '';
          const fileLabel = name || caption || '파일';
          blockText = url ? `[파일 첨부: ${fileLabel}](${url})` : `[파일 첨부: ${fileLabel}]`;
        } else if (block.type === 'pdf' && block.pdf) {
          const caption = block.pdf.caption?.map(t => t.plain_text).join('') || '';
          const url = block.pdf.file?.url || block.pdf.external?.url || '';
          const label = caption ? `PDF 첨부: ${caption}` : 'PDF 첨부';
          blockText = url ? `[${label}](${url})` : `[${label}]`;
        } else if (block.type === 'video' && block.video) {
          const caption = block.video.caption?.map(t => t.plain_text).join('') || '';
          const url = block.video.file?.url || block.video.external?.url || '';
          const label = caption ? `동영상 첨부: ${caption}` : '동영상 첨부';
          blockText = url ? `[${label}](${url})` : `[${label}]`;
        } else if (block.type === 'code' && block.code?.rich_text) {
          // 마크다운 원문을 코드 블록으로 붙여넣는 경우가 있어, 내용을 줄 단위 텍스트로 수집
          blockText = block.code.rich_text
            .map(t => t.plain_text)
            .join('')
            .split('\n')
            .map(line => line.replace(/^[#>\-\*\s]+/, '').trim())
            .filter(Boolean)
            .join('\n');
        } else if (block.type === 'quote' && block.quote?.rich_text) {
          blockText = block.quote.rich_text.map(t => t.plain_text).join('');
        } else if (block.type === 'callout' && block.callout?.rich_text) {
          blockText = block.callout.rich_text.map(t => t.plain_text).join('');
        } else if (block.type === 'toggle' && block.toggle?.rich_text) {
          blockText = block.toggle.rich_text.map(t => t.plain_text).join('');
        }

        if (blockText.trim()) {
          textDetails += blockText.trim() + '\n';
        }

        if (block.has_children) {
          const childText = await getPageContentDetails(block.id);
          textDetails += childText;
        }
      }

      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }
  } catch (error) {
    console.error(`블록(${blockId}) 파싱 실패:`, error.message);
  }
  return textDetails;
}

/**
 * Tasks 데이터베이스에서 Task ID 목록에 해당하는 상세 정보(Task 제목 등)를 가져옵니다.
 */
const projectCache = {};

async function getTasksMap(taskIds) {
  const taskMap = {};
  try {
    for (const taskId of taskIds) {
      const page = await notion.pages.retrieve({ page_id: taskId });
      const taskName = page.properties['Task']?.title?.[0]?.plain_text || page.properties['이름']?.title?.[0]?.plain_text || '';
      const dueDate = page.properties['마감일자']?.date?.end || page.properties['마감일자']?.date?.start || '';

      // Project 이름 긁어오기 (중복 조회 방지 캐싱 적용)
      const projectRelation = page.properties['Project']?.relation || [];
      let projectName = '';
      if (projectRelation.length > 0) {
        const projectId = projectRelation[0].id;
        if (projectCache[projectId]) {
          projectName = projectCache[projectId];
        } else {
          try {
            const projectPage = await notion.pages.retrieve({ page_id: projectId });
            projectName = projectPage.properties['프로젝트 명']?.title?.[0]?.plain_text || 
                          projectPage.properties['이름']?.title?.[0]?.plain_text || 
                          projectPage.properties['Project Name']?.title?.[0]?.plain_text || 
                          projectPage.properties['Name']?.title?.[0]?.plain_text || '';
            projectCache[projectId] = projectName;
          } catch (projErr) {
            console.error(`프로젝트(${projectId}) 조회 실패:`, projErr.message);
          }
        }
      }

      taskMap[taskId] = {
        name: taskName,
        url: formatNotionPageUrl(taskName, taskId),
        dueDate: dueDate,
        projectName: projectName
      };
    }
  } catch (error) {
    console.error('getTasksMap 에러:', error);
  }
  return taskMap;
}

/**
 * Weekly Plan의 '할 일' 프로퍼티를 마킹된 새 리치 텍스트 값으로 업데이트합니다.
 */
async function updateWeeklyPlanRichText(pageId, richTextArray) {
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        '할 일': {
          rich_text: richTextArray
        }
      }
    });
    return true;
  } catch (error) {
    console.error('updateWeeklyPlanRichText 에러:', error);
    throw error;
  }
}

/**
 * 진행률이 100%에 도달했으나 상태가 '✅ 완료'가 아닌 프로젝트들을 찾아 '✅ 완료'로 일괄 수정하고 목록을 반환합니다.
 */
async function syncProjectStatuses() {
  const updatedProjects = [];
  try {
    // 1. 담당자 실명 매핑을 위한 Team Members 정보 조회
    const memberMap = {};
    for (const member of await getTeamMembers()) {
      memberMap[member.id] = member.name;
    }

    // 2. 프로젝트 목록 조회
    const response = await notion.databases.query({
      database_id: config.notion.db.projects
    });

    for (const page of response.results) {
      const properties = page.properties;
      
      // 프로젝트 명 추출
      const nameProp = properties['프로젝트 명'] || properties['이름'];
      const name = nameProp?.title?.[0]?.plain_text || '이름 없음';
      
      // 진행률(rollup) 추출
      const progressProp = properties['진행률'];
      let progress = null;
      if (progressProp && progressProp.type === 'rollup' && progressProp.rollup.type === 'number') {
        progress = progressProp.rollup.number;
      }
      
      // 진행 상황(status) 추출
      const statusProp = properties['진행 상황'];
      const statusName = statusProp && statusProp.type === 'status' ? statusProp.status?.name : '';

      // 담당자(PM) 실명 추출
      const pmRelation = properties['PM']?.relation || [];
      const pmId = pmRelation[0]?.id;
      const pmName = pmId ? (memberMap[pmId] || '이름 없음') : '담당자 지정 안 됨';

      if (progress !== null) {
        const isHundred = (Math.abs(progress - 1.0) < 1e-5) || (Math.abs(progress - 100.0) < 1e-5);
        if (isHundred && statusName !== '✅ 완료') {
          // 노션 페이지 업데이트
          await notion.pages.update({
            page_id: page.id,
            properties: {
              '진행 상황': {
                status: {
                  name: '✅ 완료'
                }
              }
            }
          });
          console.log(`  -> [자동 완료] 프로젝트 '${name}' 완료 처리 성공! (담당자: ${pmName})`);
          
          updatedProjects.push({
            name,
            url: formatNotionPageUrl(name, page.id),
            pmName
          });
        }
      }
    }
  } catch (error) {
    console.error('syncProjectStatuses 에러:', error);
  }
  return updatedProjects;
}

/**
 * 마감일자가 지났으나 완료되지 않은 태스크들을 스캔하여 담당자별로 그룹화해 반환합니다.
 */
async function getOverdueTasksByMember() {
  const overdueGroup = {}; // { memberName: { position, tasks: [...] } }
  try {
    const todayKst = new Date();
    // KST 시간 보정 (UTC + 9시간) 후 YYYY-MM-DD 형식 추출
    const kstOffset = 9 * 60 * 60 * 1000;
    const todayStr = new Date(todayKst.getTime() + kstOffset).toISOString().split('T')[0];

    // 1. 멤버 정보 및 직급 매핑 테이블 빌드
    const memberMap = {};
    for (const member of await getTeamMembers()) {
      memberMap[member.id] = { name: member.name, position: member.position || '연구원' };
    }

    // 2. Tasks DB에서 완료되지 않은 모든 태스크 조회 (페이지네이션 처리)
    let hasMore = true;
    let startCursor = undefined;
    const allTasks = [];

    while (hasMore) {
      const response = await notion.databases.query({
        database_id: config.notion.db.tasks,
        start_cursor: startCursor
      });
      allTasks.push(...response.results);
      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }

    // 3. 지연 태스크 판별 및 프로젝트명 매핑
    for (const taskPage of allTasks) {
      const properties = taskPage.properties;
      const statusName = properties['진행 상황']?.status?.name || '';
      
      // 완료 및 보류된 것은 지연 대상에서 제외
      if (statusName === '✅ 완료' || statusName === '⏭ 보류') continue;

      // 마감일자 정보 추출
      const dueDateObj = properties['마감일자']?.date;
      const dueDate = dueDateObj ? (dueDateObj.end || dueDateObj.start) : null;
      if (!dueDate) continue; // 마감일이 기재 안 된 것은 제외

      // 마감일이 지났는지 체크 (오늘 날짜 이전인지 판별)
      if (dueDate < todayStr) {
        // 담당자 확인
        const assignRelation = properties['담당자']?.relation || [];
        const memberId = assignRelation[0]?.id;
        if (!memberId || !memberMap[memberId]) continue; // 담당자 없는 태스크 스킵

        const memberInfo = memberMap[memberId];
        const taskTitle = properties['Task']?.title?.[0]?.plain_text || '제목 없음';
        
        // 지연일수 계산 (KST 기준)
        const diffTime = new Date(todayStr) - new Date(dueDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        // 프로젝트명 가져오기 (캐싱 활용)
        let projectName = '독립 태스크';
        const projRelation = properties['Project']?.relation || [];
        if (projRelation.length > 0) {
          const projId = projRelation[0].id;
          if (projectCache[projId]) {
            projectName = projectCache[projId];
          } else {
            try {
              const projPage = await notion.pages.retrieve({ page_id: projId });
              projectName = projPage.properties['프로젝트 명']?.title?.[0]?.plain_text || 
                            projPage.properties['이름']?.title?.[0]?.plain_text || '프로젝트';
              projectCache[projId] = projectName;
            } catch (err) {
              console.warn(`프로젝트(${projId}) 조회 실패:`, err.message);
            }
          }
        }

        if (!overdueGroup[memberInfo.name]) {
          overdueGroup[memberInfo.name] = {
            position: memberInfo.position,
            tasks: []
          };
        }

        overdueGroup[memberInfo.name].tasks.push({
          title: taskTitle,
          dueDate: dueDate,
          delayDays: diffDays,
          projectName: projectName,
          url: taskPage.url
        });
      }
    }
  } catch (error) {
    console.error('getOverdueTasksByMember 에러:', error);
  }
  return overdueGroup;
}

module.exports = {
  getTeamMembers,
  getTeamMemberNames,
  findTeamMember,
  getWeeklyPlanPage,
  getDailyWorkLogs,
  getTasksMap,
  updateWeeklyPlanRichText,
  syncProjectStatuses,
  getOverdueTasksByMember
};
