import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Boxes, FlaskConical, Compass, MessageCircle, UserRound, X, Search, MousePointer2, History, FilePenLine, ShieldCheck, BadgeDollarSign, Calculator, ArrowRight, ArrowLeft, ChevronRight, PanelsTopLeft, type LucideIcon } from "lucide-react";
import styles from "./HelpDialog.module.css";
import { SettingsGroup, useFadingScrollbars, useExitTransition } from "./Interaction";

function HelpFlow({caption,steps}:{caption:string;steps:{icon:LucideIcon;title:string;detail:string}[]}) {
  return <figure className={styles.figure}><figcaption>{caption} · 操作示意</figcaption><ol className={styles.flow}>{steps.map(({icon:Icon,title,detail},index)=><li key={title}><Icon size={24} aria-hidden="true"/><strong>{title}</strong><span>{detail}</span>{index<steps.length-1&&<ArrowRight className={styles.arrow} size={18} aria-hidden="true"/>}</li>)}</ol></figure>;
}

const helpPages = {
  start: { title: "开始使用", description: "从工作台开始，找到需要的数据。", icon: Compass },
  workbenches: { title: "工作台", description: "采购、研发与销售的操作指引。", icon: PanelsTopLeft },
  procurement: { title: "采购工作台", description: "查看原料、更新价格和部门分流。", icon: Boxes },
  research: { title: "研发工作台", description: "查看成本与走势，编辑配方并核对启用。", icon: FlaskConical },
  sales: { title: "销售工作台", description: "产品报价、报价历史与测算工具。", icon: BadgeDollarSign },
  account: { title: "我的账号", description: "查看权限和修改密码。", icon: UserRound },
  feedback: { title: "意见反馈", description: "提交问题或建议，查看处理结果。", icon: MessageCircle },
};
type HelpPage = "home" | "procurement" | "research" | "sales";

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { closing, close } = useExitTransition(onClose);
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState<HelpPage>("home");
  const scroll = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const transition = useRef<Animation | null>(null);
  const navigating = useRef(false);
  const direction = useRef(1);
  const heading = useRef<HTMLHeadingElement>(null);
  const positions = useRef<Partial<Record<HelpPage, number>>>({});
  const returnTarget = useRef<HelpPage | null>(null);
  const navigate = async (next: HelpPage, back = false) => {
    if (navigating.current || !body.current) return;
    navigating.current = true;
    direction.current = back ? -1 : 1;
    positions.current[page] = scroll.current?.scrollTop ?? 0;
    returnTarget.current = back ? page : null;
    transition.current?.cancel();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    transition.current = body.current.animate([
      { opacity: 1, transform: "translateX(0)" },
      { opacity: 0, transform: `translateX(${reduced ? 0 : -8 * direction.current}px)` },
    ], { duration: reduced ? 60 : 100, easing: "ease-in", fill: "forwards" });
    try { await transition.current.finished; } catch { navigating.current = false; return; }
    setPage(next);
  };
  useLayoutEffect(() => {
    if (!scroll.current) return;
    scroll.current.scrollTop = positions.current[page] ?? 0;
    if (returnTarget.current) {
      scroll.current.querySelector<HTMLButtonElement>(`[data-help-page="${returnTarget.current}"]`)?.focus({ preventScroll: true });
    } else if (page !== "home") heading.current?.focus({ preventScroll: true });
    if (navigating.current && body.current) {
      transition.current?.cancel();
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      transition.current = body.current.animate([
        { opacity: 0, transform: `translateX(${reduced ? 0 : 16 * direction.current}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ], { duration: reduced ? 80 : 220, easing: "cubic-bezier(.2,.8,.2,1)" });
      navigating.current = false;
    }
  }, [page]);
  useEffect(() => () => transition.current?.cancel(), []);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  useFadingScrollbars(dialog);
  useEffect(() => {
    const trigger = previousFocus.current;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  return <dialog inert={closing} ref={dialog} className={`settings-dialog personal-profile help-dialog ${styles.dialog}`} data-closing={closing || undefined} aria-labelledby="help-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }} onMouseDown={event => {
    if (event.target !== event.currentTarget) return;
      event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }}>
    <header><h1 id="help-title">使用说明</h1><button type="button" className="icon-button" aria-label="关闭使用说明" autoFocus onClick={close}><X size={18} /></button></header>
    <div ref={body} className="personal-profile__body">
      {page === "home" ? <p className="help-intro">按主题查找操作指引。实际入口和操作以你的账号权限为准。</p> : <nav className={styles.navigation} aria-label="说明位置"><button type="button" className="secondary-button" onClick={() => navigate("home", true)}><ArrowLeft size={16} aria-hidden="true"/>返回</button><span>工作台 / {helpPages[page].title}</span></nav>}
      <div ref={scroll} className="personal-profile__scroll help-content" role="region" aria-label="使用说明内容" tabIndex={0}>
        <div hidden={page !== "home"} className={styles.page}>
          <SettingsGroup id="help-start" icon={<Compass size={16}/>} title="开始使用" description={helpPages.start.description} summary="">
          <HelpFlow caption="从查找到详情" steps={[{icon:Compass,title:"进入工作台",detail:"选择职能入口"},{icon:Search,title:"搜索与筛选",detail:"定位原料或产品"},{icon:MousePointer2,title:"点击内编",detail:"打开详情查看"}]}/>
          <ol><li><strong>选择工作台</strong><p>从左侧选择工作台，查看概览后点击“进入工作台”。</p></li><li><strong>找到需要的数据</strong><p>使用搜索和筛选定位记录，点击原料编号或产品内编查看详情。</p></li><li><strong>按权限操作</strong><p>可用操作以页面显示为准；需要调整权限时，请联系管理员。</p></li></ol>
          </SettingsGroup>
          <SettingsGroup id="help-workbenches" icon={<PanelsTopLeft size={16}/>} title="工作台" description={helpPages.workbenches.description} summary="">
            <div className={styles.directory}>{(["procurement", "research", "sales"] as const).map(key => {
              const { title, description, icon: Icon } = helpPages[key];
              return <button type="button" className={styles.entry} data-help-page={key} key={key} onClick={() => navigate(key)}><Icon size={20} aria-hidden="true"/><span><strong>{title}</strong><span>{description}</span></span><ChevronRight size={16} aria-hidden="true"/></button>;
            })}</div>
          </SettingsGroup>
          <SettingsGroup id="help-account" icon={<UserRound size={16}/>} title="我的账号" description={helpPages.account.description} summary="">
          <ul><li>点击左下角账号，打开“我的账号”，查看已授权范围或修改密码。</li><li>姓名、部门及访问权限由管理员在“用户管理”中维护。</li><li>采购和研发的启用权可由对应授权管理人员在“系统设置”中分配，调整后须确认才生效。我的权限会显示实际启用能力；普通获授权人不能转授权。</li><li>密码安全性提示仅供参考。修改成功后，需要重新登录。</li></ul>
          </SettingsGroup>
          <SettingsGroup id="help-feedback" icon={<MessageCircle size={16}/>} title="意见反馈" description={helpPages.feedback.description} summary="">
          <ul><li>点击搜索旁的反馈入口，选择“问题反馈”或“功能建议”。</li><li>描述所在页面、操作过程和实际结果，必要时附上截图。</li><li>提交后可查看处理进度和结果；反馈仅本人和管理员可见。</li></ul>
          </SettingsGroup>
        </div>
        {page !== "home" && <div key={page} className={styles.page}>
        <h2 ref={heading} tabIndex={-1} className={styles.pageTitle}>{helpPages[page].title}</h2>
        {page === "sales" && <a className={styles.jump} href="#help-calculator">查看测算工具说明<ArrowRight size={15} aria-hidden="true"/></a>}
        {page === "procurement" && <article id="help-procurement-content">
          <HelpFlow caption="采购价格生效流程" steps={[{icon:FilePenLine,title:"录入价格",detail:"核对日期与调整原因"},{icon:History,title:"保存待启用",detail:"当前价格暂不改变"},{icon:ShieldCheck,title:"确认启用",detail:"有启用权的人员操作"}]}/>
          <ul><li><strong>原料价格</strong><p>搜索原料编号，查看行情价格、库存价格、库存量和价格变化；点击可排序的表头调整顺序。点击原料编号打开详情，在顶部切换行情价格／库存价格，下面的内容随之切换。</p></li><li><strong>价格更新</strong><p>保存价格修改后，不会立即替换当前生效价格；由有启用权限的人员确认启用后生效。</p></li><li><strong>走势与历史</strong><p>在详情中查看走势，按关键词和日期查找历史；不足两期有效价格时显示“暂无走势”。采购看板还可查看价格波动和采购资讯。</p></li><li><strong>数据分流</strong><p>按部门查看关联原料。调整范围只改变部门与原料的关联，不删除原料或历史记录。</p></li></ul>
        </article>}
        {page === "research" && <article id="help-research-content">
          <figure className={styles.figure}><figcaption>两种成本口径 · 查看示意</figcaption><div className={styles.costs}><div><strong>行情优先</strong><span>优先按行情价格核算</span></div><div><strong>库存优先</strong><span>优先按库存价格核算</span></div></div><div className={styles.linked}><MousePointer2 size={18} aria-hidden="true"/><span>点击成本卡片</span><ArrowRight size={16} aria-hidden="true"/><span>联动查看对应走势与投料取价</span></div><p>缺少首选价格时按既有规则回退，实际来源以“取价依据”为准。</p></figure>
          <ul>
            <li><strong>查看成本</strong><p>在“产品成本”搜索产品内编，查看行情优先和库存优先两种成本；点击内编查看配方、取价依据和历史。采购价格更新后，系统自动重新核算。</p></li>
            <li><strong>走势与历史查找</strong><p>详情中的走势可切换日期范围，历史记录按所属日期倒序，可按日期、版本或说明搜索。缺价保留断点，悬停查看原因；只有一期有效成本时不绘制走势。</p></li>
            <li><strong>区分正式记录与历史回算</strong><p>“历史回算”是按指定配方和参考价补算历期行情的结果，不代表当时实际生产成本；回算中的库存价格为固定参考，不作为历史库存走势。查看时留意记录说明。</p></li>
            <li><strong>编辑配方</strong><p>新增待启用配方可直接填写。从已有产品详情或“配方管理”进入编辑，先选择调整原因；选择“其他”时需填写说明。可调整负责人、原料、比例、投料和收率，拖拽顺序图标调整投料顺序。</p></li>
            <li><strong>自动换算与手动成本</strong><p>比例和投料默认联动，关闭“自动换算”后可独立填写，比例合计允许超过 100%。两种成本可分别选择自动核算或手动指定；已启用的手动值不会被采购更新覆盖，恢复自动需重新核对启用。</p></li>
            <li><strong>试算与保存</strong><p>点击“试算双成本”后，修改内容会实时更新结果。保存草稿后填写区锁定，重开先显示已存结果并核验价格；“取消保存”保留填写并收起结果，可再次试算。</p></li>
            <li><strong>核对启用</strong><p>有启用权的人员核对调整原因、成本来源、前后金额和影响范围后启用。试算和草稿不改变正式成本；启用后，引用该产品的下游成本也会更新。停用配方需管理权限，删除仅用于从未启用的待启用配方。</p></li>
          </ul>
        </article>}
        {page === "sales" && <article id="help-sales-content">
          <HelpFlow caption="客户报价流程" steps={[{icon:Search,title:"选择产品",detail:"单个或多个产品"},{icon:FilePenLine,title:"测算并保存",detail:"核对客户与费用"},{icon:ShieldCheck,title:"采用报价",detail:"形成正式报价记录"}]}/>
          <ul>
            <li><strong>产品报价</strong><p>搜索产品内编，点击查看成本依据、报价参考和价格历史。在“行情优先／库存优先”之间切换查看；“价格对比”只用于比较，不改变实际报价口径。</p></li>
            <li><strong>开始报价</strong><p>选择产品后点击“开始报价”，填写客户类型、客户信息和业务员，核对成本口径及费用。特殊公摊按页面提示补充；调整默认参数或手填最终价时，按提示填写定价依据。</p></li>
            <li><strong>保存与采用</strong><p>保存报价不等于正式采用。有采用权限的人员核对后采用，可选择部分产品；成本变化或低于盈亏平衡参考价时，先处理提示再确认。</p></li>
            <li><strong>报价历史</strong><p>按客户、状态和日期查找报价，查看采用、调整及作废记录。已采用报价需要调整时，先生成调整草稿，再次采用后才形成新版本；作废会保留历史。</p></li>
          </ul>
        </article>}
        {page === "sales" && <section id="help-calculator" className={styles.calculator}><h3>测算工具</h3>
          <figure className={styles.figure}><figcaption>两种测算方向 · 对比示意</figcaption><div className={styles.costs}><div><Calculator size={22} aria-hidden="true"/><strong>常规测算</strong><span>产品成本 → 报价</span></div><div><Calculator size={22} aria-hidden="true"/><strong>反向测算</strong><span>意向报价 → 成本上限</span></div></div><p>并排对比不同公式与费用组合，展开计算过程核对。</p></figure>
          <ul><li><strong>选择成本与方向</strong><p>在销售工作台打开“测算工具”。常规测算可使用产品成本或手工成本；反向测算输入意向报价，计算可承受的产品成本上限。</p></li><li><strong>并排对比</strong><p>默认展示两个公式面板，可增加或复制面板，分别调整客户类型、费用和公式步骤，并展开计算过程核对结果。</p></li><li><strong>保存对比</strong><p>有保存权限时可保存本人对比和模板，从“历史测算”重新打开。测算工具不会修改研发成本，也不会自动生成或采用客户报价。</p></li></ul>
        </section>}


        </div>}
      </div>
    </div>
  </dialog>;
}
