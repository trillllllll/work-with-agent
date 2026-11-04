// 记忆召回评测脚本（docs/2026-11-04_memory-recall-plan.md 第 7 节 P0）。
// 只读评测副本库，拒绝指向真实数据目录；真实数据须先备份成副本（sqlite3 只读 .backup）。
//
// 用法（在仓库根目录执行）：
//   生成合成库与用例：tsx scripts/memory-recall-eval.ts --synthetic /tmp/dovun-eval-synthetic.db
//   跑评测：tsx scripts/memory-recall-eval.ts --db <库副本> --cases <用例文件> --out <结果文件>
//
// 用例格式：[{ "id", "query", "scope": { "kind", "topicId" }, "expect": [memoryId], "trivial"?: true }]
// P0 只输出旧方案结果；P2 起同一脚本追加新方案列。
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

type Scope = { kind: 'inbox' | 'topic' | 'all'; topicId?: string | null };
type EvalCase = { id: string; query: string; scope: Scope; expect: string[]; trivial?: boolean };
type CaseResult = {
  id: string;
  query: string;
  scope: Scope;
  expect: string[];
  trivial: boolean;
  old: {
    injectedIds: string[];
    briefIds: string[];
    chars: number;
    hitIds: string[];
    missedIds: string[];
    recall: number | null;
  };
  new: {
    coreIds: string[];
    recallIds: string[];
    chars: number;
    irrelevantIds: string[];
    hitIds: string[];
    missedIds: string[];
    recall: number | null;
    skipped: string | null;
  } | null;
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  return { synthetic: value('--synthetic'), db: value('--db'), cases: value('--cases'), out: value('--out') };
}

function realPath(value: string) {
  try { return realpathSync(value); } catch { return resolve(value); }
}

/** 评测只能指向副本。默认数据目录和 DOVUN_DATA_DIR 下的任何路径都直接拒绝。 */
function guardDatabasePath(raw: string, label: string) {
  const forbidden: Array<{ root: string; why: string }> = [];
  const home = process.env.HOME;
  if (home) forbidden.push({ root: realPath(`${home}/Library/Application Support/dovun`), why: '默认数据目录' });
  if (process.env.DOVUN_DATA_DIR) forbidden.push({ root: realPath(process.env.DOVUN_DATA_DIR), why: 'DOVUN_DATA_DIR' });
  const target = realPath(raw);
  for (const item of forbidden) {
    if (target === item.root || target.startsWith(`${item.root}/`)) {
      console.error(`[拒绝] ${label} 指向${item.why}（${target}）。请使用 sqlite3 只读备份出的副本。`);
      process.exit(1);
    }
  }
  return target;
}

// ---------- 合成数据（固定种子，确定性输出） ----------

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Theme = { key: string; topicId: string | null; keyword: string; alias: string; facts: string[] };

const THEMES: Theme[] = [
  { key: 'accounts', topicId: null, keyword: '账号', alias: '登录凭据', facts: ['主邮箱绑定在个人域名下，恢复码打印保存', '密码每年一月统一轮换一次', '共享账号只存密码管理器，不进聊天记录', '测试账号统一前缀 syn-，用后即弃', '双因素认证只在手机验证器里，不开启短信', '找回问题的答案全部填同一句无关短语', '公司账号和个人账号用不同浏览器档案', '付款账号单独一个邮箱，不参与日常注册', 'API 令牌按季度滚动，旧的当场吊销', '子账号只用只读权限，写入走主账号'] },
  { key: 'extensions', topicId: null, keyword: '浏览器插件', alias: '扩展程序', facts: ['广告拦截用开源版本，订阅规则每周更新', '划词翻译只在阅读英文文档时启用', '密码管理器插件锁定时间为五分钟', '开发类插件只在调试档案里安装', '阅读模式插件去掉了所有站点脚本', '截图插件默认保存到下载目录的子文件夹', '标签管理插件把超过二十个标签自动休眠', '视频倍速插件不改动站点原始播放器', 'RSS 插件每小时拉一次订阅源', '隐私插件屏蔽所有已知追踪域'] },
  { key: 'shortcuts', topicId: null, keyword: '快捷键', alias: '键位', facts: ['全局启动器绑定了组合键，应用内不再重复绑定', '窗口管理用系统自带分屏，没有装额外工具', '输入法切换保留了系统默认，没有自定义', '终端里方向键走的是自然顺序配置', '编辑器保存键映射成相邻双键，减少小指负担', '截屏区域键比全屏键更常用，绑在最顺手的位置', '剪贴板历史保留五十条，超过自动清理', '工作区切换键位与显示器编号一致', '夜览开关只在傍晚之后允许触发', '勿扰模式一键连着状态栏图标一起切'] },
  { key: 'preferences', topicId: null, keyword: '个人偏好', alias: '使用习惯', facts: ['界面字体固定用无衬线，字号一档不缩放', '深色主题只在日落后自动启用', '通知全部静音，只保留日历提醒', '邮件每天只在两个固定时段集中处理', '文档一律先写提纲再填正文', '会议默认拒绝没有议程的邀请', '休息日不看工作群，紧急事项走电话', '文件命名带日期前缀，按时间排序', '下载目录每周清空一次', '桌面只保留当天的临时文件'] },
  { key: 'server', topicId: null, keyword: '服务器', alias: '主机', facts: ['主力主机系统盘和数据盘分开，数据盘每月快照', 'SSH 只允许密钥登录，密码入口已关闭', '防火墙只放行业务端口，管理端口走内网', '系统更新安排在每月第一个周日', '磁盘用量超过八成就开始清理归档', '备份机上保留最近四周的增量', '机房维护窗口提前三天收到邮件通知', '证书到期前十四天自动续期', '时区统一设置成东八区，日志时间戳带时区', '内核参数里的连接数上限按业务峰值两倍配置'] },
  { key: 'domains', topicId: null, keyword: '域名', alias: '域名资产', facts: ['主域名注册商只留一家，续费按五年买', '子域名统一小写，用连字符不用下划线', '解析记录变更后要等缓存到期才生效', '废弃服务的子域名先降权再删除', '证书覆盖主域和一级子域，不含通配符', '邮箱域名单独一条 SPF 记录', '测试环境用单独的子域，不挂在主域下', '到期提醒发给备用邮箱，防止错过续费', '转让锁定保持开启，转移需手动解锁', '根域只做跳转，不承载任何页面'] },
  { key: 'db-backup', topicId: 'syn-topic-deploy', keyword: '数据库备份', alias: '容灾副本', facts: ['每天凌晨两点做一次全量，保留三十天', '备份文件先校验摘要再入库', '恢复演练每季度跑一次，用副本库演练', '写入高峰期禁止触发手动备份', '备份存储和主库不在同一台机器', '增量备份每小时一次，链路加密传输', '归档表不参与日常备份，单独导出', '备份脚本失败要发告警，不允许静默重试', '恢复目标是四小时内回到最近一个整点', '备份命名带日期和序号，方便二分查找'] },
  { key: 'release', topicId: 'syn-topic-deploy', keyword: '发布流程', alias: '上线步骤', facts: ['每周四下午固定发版，紧急修复走加急通道', '发布前必须通过全量回归和一次人工抽查', '灰度先放百分之五流量，观察半小时', '回滚预案写在发布单第一条', '发布窗口避开业务高峰和节假日', '数据库变更先出兼容版本，第二个版本才清理', '每个发布单只做一件事，混合变更拆开', '发布后一小时内在群里同步结果', '打标签和镜像推送由流水线完成，不手工执行', '热修分支命名带工单号，合并后即删'] },
  { key: 'logging', topicId: 'syn-topic-deploy', keyword: '日志规范', alias: '日志约定', facts: ['日志级别只分四档，禁止自定义级别', '请求日志必须带追踪标识，跨服务透传', '敏感字段在入口统一脱敏，出口不补写', '采样率按接口重要程度分级设置', '日志保留九十天，之后转冷存储', '禁止在循环里输出逐条日志，只记汇总', '结构化日志字段名用小驼峰', '错误日志必须附带上下文快照', '采集延迟超过阈值就丢弃，不阻塞业务', '每周生成一份日志量报表同步给负责人'] },
  { key: 'env', topicId: 'syn-topic-deploy', keyword: '环境变量', alias: '配置项', facts: ['密钥只进环境变量，不写进代码和文档', '开发环境默认指向本地，覆盖需显式声明', '变量名统一大写下划线，前缀区分模块', '变更配置要先在预发环境验证', '每个服务维护一份变量清单和负责人', '删除变量前先搜索全部代码引用', '默认值只在示例文件里出现', '启动时校验必填变量，缺失即退出', '配置版本随发布单一起留档', '本地调试允许临时覆盖，提交前必须还原'] },
  { key: 'upgrade', topicId: 'syn-topic-deploy', keyword: '依赖升级', alias: '版本更新', facts: ['次版本每月批量升一次，主版本单独评估', '升级前先看变更记录里的破坏性条目', '锁文件里的精确版本不许手改', '升级后跑一遍冒烟用例再合并', '放弃维护的依赖当周替换，不留过夜', '安全通告里的高危漏洞四十八小时内处理', '新依赖引入需要说明用途和替代方案', '回归失败就停在分支上，不覆盖主干', '依赖报告每周生成，标注过期时长', '构建工具升级单独走一个发布单'] },
  { key: 'monitor', topicId: 'syn-topic-deploy', keyword: '监控告警', alias: '报警规则', facts: ['告警先分级，低级只进日报，高级才打电话', '同源告警五分钟内合并，避免轰炸', '恢复通知和触发通知走同一渠道', '每条告警必须写处理手册链接', '静默窗口要写明原因和时长', '指标阈值按历史九十九分位设置', '拨测从两个地域同时发起', '面板按服务分组，首页只放核心曲线', '告警规则变更走评审，不直接改线上', '每周清理一次永远不触发的规则'] },
  { key: 'rollback', topicId: 'syn-topic-deploy', keyword: '回滚', alias: '版本退回', facts: ['回滚只回代码，不回数据库结构', '执行回滚前先截图当前版本号', '回滚后立即验证核心链路三件事', '连续两次回滚要升级到负责人复盘', '回滚脚本每月演练一次', '镜像保留最近十个可回版本', '配置回滚和代码回滚分开执行', '回滚期间禁止并发发布', '成功回滚也要补一条事件记录', '灰度阶段的回滚只影响灰度分组'] },
  { key: 'image', topicId: 'syn-topic-deploy', keyword: '容器镜像', alias: '镜像构建', facts: ['基础镜像统一一个版本，业务镜像基于它构建', '镜像标签用提交号，latest 只做展示', '构建缓存命中率低于七成就要排查', '镜像体积超过上限直接构建失败', '私有仓库凭据三十天轮换', '拉取走内网代理，外网只留备用', '每周扫描一次镜像漏洞，高危当周修复', '构建产物不带测试数据', '多阶段构建保证最终层只留运行时', '废弃镜像每月清理一次'] },
  { key: 'permission', topicId: 'syn-topic-product', keyword: '权限模型', alias: '访问控制', facts: ['角色按岗位定义，禁止给个人单独开角色', '权限申请必须写明用途和期限', '离职流程里第一项就是回收权限', '越权操作默认拒绝，白名单例外', '管理权限双人复核才生效', '权限审计每月导出一次存档', '临时权限到期自动回收', '默认角色只有读取，没有写入', '权限变更保留完整操作记录', '跨部门权限走上级加签'] },
  { key: 'auth', topicId: 'syn-topic-product', keyword: '接口鉴权', alias: '认证方式', facts: ['外部请求一律带令牌，匿名入口只留健康检查', '令牌有效期两小时，刷新令牌七天', '签名算法固定一种，禁止协商降级', '时间戳偏差超过五分钟直接拒绝', '重放防护靠一次性随机数', '内部服务之间走双向证书', '密钥存专用模块，进程内存里不留明文', '鉴权失败要记录来源和路径', '管理接口额外加来源地址限制', '第三方回调走独立校验通道'] },
  { key: 'audit', topicId: 'syn-topic-product', keyword: '审计日志', alias: '操作留痕', facts: ['写操作全部留痕，读取只记敏感对象', '审计记录不可修改，只允许追加', '操作人、时间、对象、结果四要素齐全', '导出审计要单独申请并留档', '异常行为自动生成事件单', '审计保存三年，到期归档', '批量操作记录拆到单条对象级别', '审计时间用统一时钟源', '失败操作也要留痕，含拒绝原因', '审计面板只读，不提供删除入口'] },
  { key: 'export', topicId: 'syn-topic-product', keyword: '数据导出', alias: '批量取数', facts: ['导出上限十万行，超出的走异步任务', '敏感列默认掩码，明文要二次授权', '导出文件七天后自动删除', '每次导出记录申请人和用途', '大导出避开业务高峰时段', '导出格式默认表格，其他格式单独开', '导出前必须先通过行数预估确认', '失败任务可重试一次，之后重新申请', '导出结果校验行数和摘要', '公共目录不留导出副本'] },
  { key: 'ratelimit', topicId: 'syn-topic-product', keyword: 'API 限流', alias: '流量控制', facts: ['单用户每分钟六十次，突发额度翻倍', '超限返回标准状态码和重试提示', '限流键优先用用户标识，匿名用地址', '白名单只给内部巡检', '限流命中计入监控，不进审计', '阈值调整走配置中心，不重启生效', '限流在网关层先拦，服务层兜底', '慢接口单独更严的配额', '放量活动提前申请临时提升', '限流数据保留七天用于复盘'] },
  { key: 'cache', topicId: 'syn-topic-product', keyword: '缓存策略', alias: '缓存规则', facts: ['热点数据缓存五分钟，冷数据不缓存', '缓存键统一前缀加版本号', '更新先写库再删缓存，不做双写', '雪崩防护用随机过期偏移', '穿透防护布隆过滤器前置', '缓存命中率低于八成就告警', '大对象超过阈值禁止进缓存', '本地缓存只存配置类小数据', '缓存清理任务在低峰执行', '回源并发做单飞合并'] },
  { key: 'notify', topicId: 'syn-topic-product', keyword: '消息通知', alias: '推送规则', facts: ['通知分级：即时、汇总、静默', '同类型通知十分钟内合并', '夜间只发即时级，其余进次日上午汇总', '通知文案必须带跳转链接', '用户可关闭非即时通知', '发送失败重试两次后进死信', '关键操作要双通道提醒', '通知模板变更走审核', '月度通知量报表发给运营', '测试通知只能发到测试账号'] },
  { key: 'i18n', topicId: 'syn-topic-product', keyword: '多语言', alias: '国际化', facts: ['文案全部走资源文件，禁止硬编码', '键名按页面分组，命名带上下文', '占位符只允许位置参数', '新增文案先补默认语言', '翻译变更走平台审校', '日期和数字用本地化格式', ' RTL 布局单独测试用例', '缺失文案回退默认语言并记日志', '文案长度变化预留三成空间', '发布前跑一遍完整性检查'] },
  { key: 'method', topicId: 'syn-topic-study', keyword: '记忆方法', alias: '记忆技巧', facts: ['新概念先用自己的话复述一遍再记', '抽象内容配一个具体例子', '睡前复习当天内容，早晨抽查', '记忆卡片一张只记一个知识点', '记不住的内容改成问句形式', '同类概念列表格对比差异', '复杂流程画成步骤图', '每周把旧卡片重新洗牌抽查', '错过的知识点隔天再看一次', '长期不用的事实只记出处'] },
  { key: 'rhythm', topicId: 'syn-topic-study', keyword: '练习节奏', alias: '做题安排', facts: ['一次练习不超过四十分钟', '新内容学完当天做第一轮练习', '隔天、一周、一月各复习一次', '连续错三题就停下回到讲解', '正确率连续九成以上进入下一节', '每天固定时段练习，形成习惯', '练习前先看上次错题', '真题留到冲刺阶段', '练习中间休息五分钟', '疲劳时只做低难度题'] },
  { key: 'review', topicId: 'syn-topic-study', keyword: '复习间隔', alias: '复习周期', facts: ['第一次复习在学习后二十四小时内', '间隔按倍数拉长，直到不再遗忘', '忘记的内容重置回最短间隔', '考试前两周缩短间隔', '每周末做一次混合复习', '复习只抽查，不整页重读', '复习结果决定下次间隔', '高难度内容间隔增长更慢', '连续三次通过转为长期间隔', '间隔数据同步到日历'] },
  { key: 'notes', topicId: 'syn-topic-study', keyword: '笔记格式', alias: '笔记约定', facts: ['每条笔记标题用完整短句', '正文先结论后细节', '例子和引用放在折叠区', '一页笔记只讲一个主题', '术语第一次出现时写全称', '修改历史不删，用修订标记', '外部资料存链接和摘录', '每周整理一次收件箱笔记', '归档笔记按主题编号', '模板变更全体笔记不回改'] },
  { key: 'mistakes', topicId: 'syn-topic-study', keyword: '错题本', alias: '错题记录', facts: ['错题记录题号、错因和正确思路', '错因分成概念、计算、审题三类', '同类型错三次升级成专项', '错题改正后隔周重做', '重做通过才标记掌握', '错题本每周翻一遍', '考试前只看错题本', '错题不抄题干，只记编号', '掌握的错题移入归档区', '每月统计各类错因占比'] },
  { key: 'schedule', topicId: 'syn-topic-study', keyword: '课程表', alias: '学习安排', facts: ['工作日晚上两小时，周末上午三小时', '每个时段只排一个科目', '连续两周落后就压缩范围', '新课安排在精力最好的时段', '复习穿插在新课之间', '每周留一个空档补进度', '月末复盘调整下月安排', '临时占用的时段当天补回', '打卡记录贴在课程表旁边', '假期安排单独一张表'] },
  { key: 'exam', topicId: 'syn-topic-study', keyword: '考试安排', alias: '考核计划', facts: ['模拟考按真实时长计时', '考前一周只复习不学新内容', '考点清单对着大纲逐条打勾', '易错点单独列一页', '答题顺序先易后难', '主观题先写要点再展开', '交卷前留十分钟检查', '考后三天内完成复盘', '成绩只和上次比，不和别人比', '两次模拟之间隔一周'] },
  { key: 'tools', topicId: 'syn-topic-study', keyword: '学习工具', alias: '学习软件', facts: ['视频课开一点五倍速', '笔记软件只装一个，不迁移', '计时器用番茄工作法', '听课时手机放另一个房间', '平板只用于看资料和做题', '打印的讲义按章节装订', '浏览器收藏夹按课程分类', '桌面白板用来默写框架', '学习数据每周导出备份', '卸载所有游戏到考试结束'] },
];

const TOPICS = [
  { id: 'syn-topic-deploy', name: '合成-部署与发布' },
  { id: 'syn-topic-product', name: '合成-产品与权限' },
  { id: 'syn-topic-study', name: '合成-学习与笔记' },
];

async function buildSynthetic(dbPath: string) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(dbPath + suffix, { force: true });
  await mkdir(dirname(dbPath), { recursive: true });
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const schema = resolve(repoRoot, 'server/prisma/schema.prisma');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schema], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
  });
  process.env.DATABASE_URL = `file:${dbPath}`;
  const { prisma } = await import('../server/src/infrastructure/prisma.js');

  const rand = mulberry32(20261104);
  const baseTime = Date.parse('2026-09-01T08:00:00.000Z');
  const stamp = (index: number) => new Date(baseTime + index * 60_000).toISOString();

  // 特殊 kind 的固定配额：10 constraint、8 decision、6 learning、4 question，其余 fact。
  const specialKinds: Array<[number, string]> = [];
  for (let i = 0; i < 10; i++) specialKinds.push([i * 29 % 300, 'constraint']);
  for (let i = 0; i < 8; i++) specialKinds.push([i * 37 + 11, 'decision']);
  for (let i = 0; i < 6; i++) specialKinds.push([i * 41 + 7, 'learning']);
  for (let i = 0; i < 4; i++) specialKinds.push([i * 53 + 19, 'question']);
  const kindOf = (index: number) => {
    const found = specialKinds.filter(([at]) => at === index);
    return found.length ? found[0][1] : 'fact';
  };
  const importanceOf = () => {
    const roll = rand();
    if (roll < 0.1) return 1;
    if (roll < 0.45) return 2;
    if (roll < 0.8) return 3;
    if (roll < 0.95) return 4;
    return 5;
  };

  const memories: Array<{ id: string; identityId: string; topicId: string | null; kind: string; title: string; content: string; status: string; health: string; importance: number; labels: string; origin: string; revision: number; evidence: string; createdAt: string; updatedAt: string }> = [];
  const factById = new Map<string, string>();
  let index = 0;
  for (const theme of THEMES) {
    theme.facts.forEach((fact, factIndex) => {
      // 每四条里有一条用别名改写标题，模拟近义改写。
      const aliased = factIndex % 4 === 0;
      const head = aliased ? theme.alias : theme.keyword;
      const detail = `${fact}。这条是${theme.key}主题的第${factIndex + 1}条记录，用于评测检索。`;
      const id = `mem-${String(index + 1).padStart(4, '0')}`;
      factById.set(id, fact);
      memories.push({
        id,
        identityId: 'work',
        topicId: theme.topicId,
        kind: kindOf(index),
        title: `${head}约定：${fact.slice(0, 24)}`,
        content: detail,
        status: 'active',
        health: 'current',
        importance: importanceOf(),
        labels: JSON.stringify([theme.key]),
        origin: 'manual',
        revision: 1,
        evidence: '[]',
        createdAt: stamp(index),
        updatedAt: stamp(index),
      });
      index += 1;
    });
  }
  for (const topic of TOPICS) {
    await prisma.topic.create({ data: { id: topic.id, name: topic.name, createdAt: stamp(0), updatedAt: stamp(0) } });
  }
  await prisma.memory.createMany({ data: memories });

  // 30 个用例：16 单期望（含 2 条近义标题）、2 条 all 范围、4 多期望、4 简单回复、4 追问。
  // 查询模拟真实问法：引用记忆正文里的两段短语（头 8 字 + 尾 8 字），
  // 而不是"单关键词+填充词"——后者只产生 1 个 3 字切片，会被命中门槛全部挡掉。
  const quoteOf = (fact: string) => `${fact.slice(0, 8)}，${fact.length >= 22 ? fact.slice(-8) : fact.slice(8, 16)}，这条约定现在是什么？`;
  const byTheme = (key: string) => memories.filter((memory) => THEMES.find((theme) => theme.key === key && memory.labels.includes(key)));
  const cases: EvalCase[] = [];
  let caseNo = 0;
  const addCase = (query: string, scope: Scope, expect: string[], trivial = false) => { caseNo += 1; cases.push({ id: `syn-${String(caseNo).padStart(2, '0')}`, query, scope, expect, ...(trivial ? { trivial: true } : {}) }); };

  const inboxThemes = THEMES.filter((theme) => theme.topicId === null);
  inboxThemes.slice(0, 4).forEach((theme, themeIndex) => {
    const pool = byTheme(theme.key);
    const memory = pool[themeIndex % pool.length];
    addCase(quoteOf(factById.get(memory.id)!), { kind: 'inbox' }, [memory.id]);
  });
  const topicPlan: Array<[string, string]> = [
    ['db-backup', 'syn-topic-deploy'], ['release', 'syn-topic-deploy'], ['logging', 'syn-topic-deploy'],
    ['permission', 'syn-topic-product'], ['auth', 'syn-topic-product'], ['cache', 'syn-topic-product'], ['i18n', 'syn-topic-product'],
    ['method', 'syn-topic-study'], ['review', 'syn-topic-study'], ['mistakes', 'syn-topic-study'],
  ];
  topicPlan.forEach(([themeKey, topicId], i) => {
    const pool = byTheme(themeKey);
    const memory = pool[i % pool.length];
    addCase(quoteOf(factById.get(memory.id)!), { kind: 'topic', topicId }, [memory.id]);
  });
  // 近义改写：期望条目的标题用别名，query 用别名加事实短语。
  const aliasPlan: Array<[string]> = [['monitor'], ['notify']];
  for (const [themeKey] of aliasPlan) {
    const theme = THEMES.find((item) => item.key === themeKey)!;
    const aliasMemory = byTheme(themeKey).find((memory) => memory.title.startsWith(theme.alias));
    if (aliasMemory) addCase(`${theme.alias}，${factById.get(aliasMemory.id)!.slice(0, 8)}，这条约定现在是什么？`, { kind: 'topic', topicId: theme.topicId! }, [aliasMemory.id]);
  }
  // all 范围只含收集箱（与现状一致）。
  addCase(quoteOf(factById.get(byTheme('server')[0].id)!), { kind: 'all' }, [byTheme('server')[0].id]);
  addCase(quoteOf(factById.get(byTheme('domains')[2].id)!), { kind: 'all' }, [byTheme('domains')[2].id]);

  // 多期望：两条记忆各引一段短语。
  const multiPlan: Array<[string, Scope]> = [
    ['env', { kind: 'topic', topicId: 'syn-topic-deploy' }],
    ['rollback', { kind: 'topic', topicId: 'syn-topic-deploy' }],
    ['accounts', { kind: 'inbox' }],
    ['export', { kind: 'topic', topicId: 'syn-topic-product' }],
  ];
  for (const [themeKey, scope] of multiPlan) {
    const pool = byTheme(themeKey);
    const first = factById.get(pool[1].id)!;
    const second = factById.get(pool[5].id)!;
    addCase(`${first.slice(0, 8)} 和 ${second.slice(0, 8)} 的约定分别说一下`, scope, [pool[1].id, pool[5].id]);
  }

  addCase('好的', { kind: 'inbox' }, [], true);
  addCase('嗯嗯', { kind: 'topic', topicId: 'syn-topic-deploy' }, [], true);
  addCase('谢谢！', { kind: 'inbox' }, [], true);
  addCase('ok', { kind: 'all' }, [], true);
  addCase('那第二条呢？', { kind: 'topic', topicId: 'syn-topic-product' }, []);
  addCase('展开说说', { kind: 'topic', topicId: 'syn-topic-study' }, []);
  addCase('还有吗', { kind: 'inbox' }, []);
  addCase('第一点再讲一次', { kind: 'topic', topicId: 'syn-topic-deploy' }, []);

  const casesPath = `${dbPath}.cases.json`;
  await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
  await prisma.$disconnect();
  console.log(`[合成库] ${memories.length} 条记忆、${cases.length} 个用例 → ${dbPath} / ${casesPath}`);
}

// ---------- 评测 ----------

async function runEval(dbPath: string, casesPath: string, outPath: string) {
  process.env.DATABASE_URL = `file:${dbPath}`;
  const { formatMemoryReference } = await import('../server/src/application/agent-memory.js');
  const { buildMemoryContext } = await import('../server/src/application/memory-recall.js');
  const { takeKnowledgeSnapshot } = await import('../server/src/application/knowledge.js');
  const { ownerActor } = await import('../server/src/application/security.js');
  const { codePointLength } = await import('../server/src/application/library/text.js');
  const { prisma } = await import('../server/src/infrastructure/prisma.js');

  const loaded = JSON.parse(await readFile(casesPath, 'utf8')) as EvalCase[];
  const known = new Set((await prisma.memory.findMany({ select: { id: true } })).map((row) => row.id));
  for (const item of loaded) {
    const unknown = item.expect.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`用例 ${item.id} 引用不存在的记忆：${unknown.join(', ')}`);
  }

  const results: CaseResult[] = [];
  for (const item of loaded) {
    const topicId = item.scope.kind === 'topic' ? String(item.scope.topicId ?? '') || null : null;
    const block = await formatMemoryReference({ topicId, identityId: 'work' });
    const entryIds = [...block.matchAll(/^- id=(\S+) revision=/gm)].map((match) => match[1]);
    const blockChars = codePointLength(block);
    let briefIds: string[] = [];
    let briefChars = 0;
    if (item.scope.kind !== 'all') {
      const snapshot = await takeKnowledgeSnapshot(ownerActor, { topicId });
      for (const source of snapshot.sources.filter((source) => source.type === 'memory')) {
        briefIds.push(source.id);
        briefChars += codePointLength(`- memory ${source.title}：${source.content.slice(0, 200)}`);
      }
    }
    const injected = [...new Set([...entryIds, ...briefIds])];
    const hit = item.expect.filter((id) => injected.includes(id));
    const missed = item.expect.filter((id) => !injected.includes(id));

    // 新方案（P2 起）：注入 = 常驻 ∪ 相关记忆；字数 = coreText + recallText。
    const memoryContext = await buildMemoryContext({ topicId, identityId: 'work', userText: item.query });
    const newInjected = [...memoryContext.stats.coreIds, ...memoryContext.stats.recallIds];
    const newHit = item.expect.filter((id) => newInjected.includes(id));
    const newMissed = item.expect.filter((id) => !newInjected.includes(id));
    const irrelevant = memoryContext.stats.recallIds.filter((id) => !item.expect.includes(id));

    results.push({
      id: item.id, query: item.query, scope: item.scope, expect: item.expect, trivial: Boolean(item.trivial),
      old: {
        injectedIds: injected, briefIds, chars: blockChars + briefChars,
        hitIds: hit, missedIds: missed,
        recall: item.expect.length ? hit.length / item.expect.length : null,
      },
      new: {
        coreIds: memoryContext.stats.coreIds,
        recallIds: memoryContext.stats.recallIds,
        chars: memoryContext.stats.coreChars + memoryContext.stats.recallChars,
        irrelevantIds: irrelevant,
        hitIds: newHit, missedIds: newMissed,
        recall: item.expect.length ? newHit.length / item.expect.length : null,
        skipped: memoryContext.stats.skipped,
      },
    });
  }
  await prisma.$disconnect();

  const measurable = results.filter((item) => item.expect.length > 0);
  const nonTrivial = results.filter((item) => !item.trivial);
  const oldRecallMean = measurable.length ? measurable.reduce((sum, item) => sum + (item.old.recall ?? 0), 0) / measurable.length : null;
  const newRecallMean = measurable.length ? measurable.reduce((sum, item) => sum + (item.new?.recall ?? 0), 0) / measurable.length : null;
  const aggregate = {
    schemes: ['old', 'new'],
    cases: results.length,
    measurableCases: measurable.length,
    recallMean: { old: oldRecallMean, new: newRecallMean },
    charsMean: {
      old: results.length ? results.reduce((sum, item) => sum + item.old.chars, 0) / results.length : null,
      new: results.length ? results.reduce((sum, item) => sum + (item.new?.chars ?? 0), 0) / results.length : null,
    },
    irrelevantMean: nonTrivial.length ? nonTrivial.reduce((sum, item) => sum + (item.new?.irrelevantIds.length ?? 0), 0) / nonTrivial.length : null,
    trivialClean: results.filter((item) => item.trivial).filter((item) => (item.new?.recallIds.length ?? 1) === 0).length,
    trivialTotal: results.filter((item) => item.trivial).length,
    missedCaseIds: {
      old: measurable.filter((item) => (item.old.recall ?? 1) < 1).map((item) => item.id),
      new: measurable.filter((item) => (item.new?.recall ?? 1) < 1).map((item) => item.id),
    },
  };
  const report = { generatedAt: new Date().toISOString(), db: dbPath, cases: casesPath, aggregate, results };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const pct = (value: number | null) => (typeof value === 'number' ? `${(value * 100).toFixed(1)}%` : '—');
  console.log(`[评测] ${results.length} 个用例 → ${outPath}`);
  console.log(`[旧方案] 召回 ${pct(aggregate.recallMean.old)}；字数均值 ${aggregate.charsMean.old === null ? '—' : Math.round(aggregate.charsMean.old)}`);
  console.log(`[新方案] 召回 ${pct(aggregate.recallMean.new)}；字数均值 ${aggregate.charsMean.new === null ? '—' : Math.round(aggregate.charsMean.new)}；无关条目均值 ${aggregate.irrelevantMean === null ? '—' : aggregate.irrelevantMean.toFixed(2)}；简单回复干净 ${aggregate.trivialClean}/${aggregate.trivialTotal}；漏召回 ${aggregate.missedCaseIds.new.join(', ') || '无'}`);
}

async function main() {
  const args = parseArgs();
  if (args.synthetic) {
    await buildSynthetic(guardDatabasePath(args.synthetic, '--synthetic'));
    return;
  }
  if (!args.db || !args.cases || !args.out) {
    console.error('用法：--synthetic <库路径> 或 --db <库路径> --cases <用例文件> --out <结果文件>');
    process.exit(1);
  }
  await runEval(guardDatabasePath(args.db, '--db'), args.cases, args.out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
