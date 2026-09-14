import { useEffect, useRef } from "react";
import { Boxes, FlaskConical, Compass, MessageCircle, UserRound, X } from "lucide-react";
import { SettingsGroup, useFadingScrollbars, useExitTransition } from "./Interaction";

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { closing, close } = useExitTransition(onClose);
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  useFadingScrollbars(dialog);
  useEffect(() => {
    const trigger = previousFocus.current;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  return <dialog inert={closing} ref={dialog} className="settings-dialog personal-profile help-dialog" data-closing={closing || undefined} aria-labelledby="help-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }} onMouseDown={event => {
    if (event.target !== event.currentTarget) return;
      event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  }}>
    <header><h1 id="help-title">使用说明</h1><button type="button" className="icon-button" aria-label="关闭使用说明" autoFocus onClick={close}><X size={18} /></button></header>
    <div className="personal-profile__body">
      <p className="help-intro">按你的权限使用对应功能。</p>
      <div className="personal-profile__scroll help-content" role="region" aria-label="使用说明内容" tabIndex={0}>
        <SettingsGroup id="help-start" icon={<Compass size={16} />} title="开始使用" description="从工作台开始，找到需要的数据。" summary="" defaultOpen>
          <ol><li><strong>选择工作台</strong><p>从左侧选择工作台，查看概览后点击“进入工作台”。</p></li><li><strong>找到需要的数据</strong><p>使用搜索和筛选定位记录，点击原料编号或产品内编查看详情。</p></li><li><strong>按权限操作</strong><p>可用操作以页面显示为准；需要调整权限时，请联系管理员。</p></li></ol>
        </SettingsGroup>
        <SettingsGroup id="help-procurement" icon={<Boxes size={16} />} title="采购工作台" description="查看原料、更新价格和部门分流。" summary="">
          <ul><li><strong>原料价格</strong><p>集中查看原料价格、变化和历史记录。点击原料编号可打开详情。</p></li><li><strong>价格更新</strong><p>保存价格修改后，不会立即替换当前生效价格；由有启用权限的人员确认启用后生效。</p></li><li><strong>数据分流</strong><p>按部门查看关联原料。调整范围只改变部门与原料的关联，不删除原料或历史记录。</p></li></ul>
        </SettingsGroup>
        <SettingsGroup id="help-research" icon={<FlaskConical size={16} />} title="研发工作台" description="查看双成本，调整配方并核对启用。" summary="">
          <ul>
            <li><strong>查看成本</strong><p>在“产品成本”搜索产品内编，查看最新优先和库存优先两种成本；点击内编查看配方、取价依据和历史。采购价格更新后，系统自动重新核算。</p></li>
            <li><strong>编辑配方</strong><p>新增待启用配方可直接填写。从已有产品详情或“配方管理”进入编辑，先选择调整原因；选择“其他”时需填写说明。可调整负责人、原料、比例、投料和收率，拖拽顺序图标调整投料顺序。</p></li>
            <li><strong>自动换算与手动成本</strong><p>比例和投料默认联动，关闭“自动换算”后可独立填写，比例合计允许超过 100%。两种成本可分别选择自动核算或手动指定；已启用的手动值不会被采购更新覆盖，恢复自动需重新核对启用。</p></li>
            <li><strong>试算与保存</strong><p>点击“试算双成本”后，修改内容会实时更新结果。保存草稿后填写区锁定，重开先显示已存结果并核验价格；“取消保存”保留填写并收起结果，可再次试算。</p></li>
            <li><strong>核对启用</strong><p>有启用权的人员核对调整原因、成本来源、前后金额和影响范围后启用。试算和草稿不改变正式成本；启用后，引用该产品的下游成本也会更新。停用配方需管理权限，删除仅用于从未启用的待启用配方。</p></li>
          </ul>
        </SettingsGroup>
        <SettingsGroup id="help-account" icon={<UserRound size={16} />} title="我的账号" description="查看权限和修改密码。" summary="">
          <ul><li>点击左下角账号，打开“我的账号”，查看已授权范围或修改密码。</li><li>姓名、部门及访问权限由管理员在“用户管理”中维护。</li><li>采购和研发的启用权可由对应授权管理人员在“系统设置”中分配，调整后须确认才生效。我的权限会显示实际启用能力；普通获授权人不能转授权。</li><li>密码安全性提示仅供参考。修改成功后，需要重新登录。</li></ul>
        </SettingsGroup>
        <SettingsGroup id="help-feedback" icon={<MessageCircle size={16} />} title="意见反馈" description="提交问题或建议，查看处理结果。" summary="">
          <ul><li>点击搜索旁的反馈入口，选择“问题反馈”或“功能建议”。</li><li>描述所在页面、操作过程和实际结果，必要时附上截图。</li><li>提交后可查看处理进度和结果；反馈仅本人和管理员可见。</li></ul>
        </SettingsGroup>
      </div>
    </div>
  </dialog>;
}
