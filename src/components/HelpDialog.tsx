import { useEffect, useRef } from "react";
import { Boxes, Compass, MessageCircle, UserRound, X } from "lucide-react";
import { SettingsGroup, useFadingScrollbars } from "./SettingsDialog";

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useFadingScrollbars(dialog);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="settings-dialog personal-profile help-dialog" aria-labelledby="help-title" onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }} onMouseDown={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <header><h1 id="help-title">使用说明</h1><button type="button" className="icon-button" aria-label="关闭使用说明" autoFocus onClick={onClose}><X size={18} /></button></header>
    <div className="personal-profile__body">
      <p className="help-intro">按你的权限使用对应功能。</p>
      <div className="personal-profile__scroll help-content" role="region" aria-label="使用说明内容" tabIndex={0}>
        <SettingsGroup id="help-start" icon={<Compass size={16} />} title="开始使用" description="从工作台开始，找到需要的数据。" summary="" defaultOpen>
          <ol><li><strong>选择工作台</strong><p>从左侧选择工作台，查看概览后点击“进入工作台”。</p></li><li><strong>找到需要的数据</strong><p>使用搜索和筛选定位记录，点击原料编号查看详情。</p></li><li><strong>按权限操作</strong><p>可用操作以页面显示为准；需要调整权限时，请联系管理员。</p></li></ol>
        </SettingsGroup>
        <SettingsGroup id="help-procurement" icon={<Boxes size={16} />} title="采购工作台" description="查看原料、更新价格和部门分流。" summary="">
          <ul><li><strong>原料台账</strong><p>集中查看原料价格、变化和历史记录。点击原料编号可打开详情。</p></li><li><strong>价格更新</strong><p>保存价格修改后，不会立即替换当前生效价格；由有启用权限的人员确认启用后生效。</p></li><li><strong>数据分流</strong><p>按部门查看关联原料。调整范围只改变部门与原料的关联，不删除原料或历史记录。</p></li></ul>
        </SettingsGroup>
        <SettingsGroup id="help-account" icon={<UserRound size={16} />} title="我的账号" description="查看权限和修改密码。" summary="">
          <ul><li>点击左下角账号，打开“我的账号”，查看已授权范围或修改密码。</li><li>姓名、部门及访问权限由管理员在“用户管理”中维护。</li><li>密码安全性提示仅供参考。修改成功后，需要重新登录。</li></ul>
        </SettingsGroup>
        <SettingsGroup id="help-feedback" icon={<MessageCircle size={16} />} title="意见反馈" description="提交问题或建议，查看处理结果。" summary="">
          <ul><li>点击搜索旁的反馈入口，选择“问题反馈”或“功能建议”。</li><li>描述所在页面、操作过程和实际结果，必要时附上截图。</li><li>提交后可查看处理进度和结果；反馈仅本人和管理员可见。</li></ul>
        </SettingsGroup>
      </div>
    </div>
  </dialog>;
}
