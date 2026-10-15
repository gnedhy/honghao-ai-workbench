import {useEffect, useRef, useState, type ReactNode} from 'react';
import {ArrowLeft, Banknote, Bot, ChevronRight, CircleCheck, Gauge, KeyRound, LoaderCircle, RefreshCw, Search, Users} from 'lucide-react';
import {fetchAdminAIConfig, fetchAdminAIQueue, fetchAdminAIUsage, saveAdminAIConfig, saveAICredential, testAIConnection, type AIAdminUsage, type AIConfig, type AIConfigSection, type AIConfigValues, type AIQueueState} from '../api';
import type {ManagedUser} from '../types';
import {useFadingScrollbars, useUnsavedChanges} from './Interaction';
import {WorkbenchOptionMenu} from './WorkbenchMenus';
import {EmptyState} from './WorkbenchLayout';
import {aiAmountError, queueElapsed} from './aiConfigValues';
import './AIConfigSettings.css';

const pages = ['模型接入', '预算与用量', '并发与排队'] as const;
const sections: Record<typeof pages[number], AIConfigSection> = {'模型接入': 'models', '预算与用量': 'budget', '并发与排队': 'concurrency'};
const effortName: Record<string, string> = {low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', none: '关闭推理'};
const money = (value: number | string) => `¥${Number(value).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 4})}`;
const count = (value: number) => Number(value).toLocaleString('zh-CN');
const message = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';

function numericFields(config: AIConfig, section: AIConfigSection): Record<string, string> {
  if (section === 'models') return Object.fromEntries(Object.entries(config.models.value.prices).flatMap(([model, rates]) => Object.entries(rates).map(([name, value]) => [`${model}:${name}`, String(value)])));
  if (section === 'budget') {
    const budget = config.budget.value;
    return {company_monthly_cny: budget.company_monthly_cny == null ? '' : String(budget.company_monthly_cny), user_monthly_cny: budget.user_monthly_cny == null ? '' : String(budget.user_monthly_cny), ...Object.fromEntries(Object.entries(budget.user_overrides).map(([owner, amount]) => [`user:${owner}`, amount == null ? '' : String(amount)]))};
  }
  return Object.fromEntries(Object.entries(config.concurrency.value).map(([name, value]) => [name, String(value)]));
}

function Card({icon, title, action, children}: {icon: ReactNode; title: string; action?: ReactNode; children: ReactNode}) {
  return <section className="ai-config__group"><div className="ai-config__group-heading"><h3>{icon}{title}</h3>{action}</div><div className="ai-config__card">{children}</div></section>;
}

export function AIConfigSettings({users, onBusy, onGuardChange}: {users: ManagedUser[]; onBusy: (value: boolean) => void; onGuardChange: (guard: (() => Promise<boolean>) | null) => void}) {
  const [page, setPage] = useState<typeof pages[number]>('模型接入');
  const [editingOverrides, setEditingOverrides] = useState(false);
  const [detail, setDetail] = useState<'reasoning' | 'access' | 'billing' | 'usage' | 'queue' | null>(null);
  const [editingPrices, setEditingPrices] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const section = sections[page];
  const [config, setConfig] = useState<AIConfig | null>(null);
  const [draft, setDraft] = useState<AIConfigValues | null>(null);
  const [numbers, setNumbers] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [usage, setUsage] = useState<AIAdminUsage | null>(null);
  const [queue, setQueue] = useState<AIQueueState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [validationError, setValidationError] = useState(false);
  const [notice, setNotice] = useState('');
  const [dataError, setDataError] = useState('');
  const [dataLoading, setDataLoading] = useState(false);
  const [dataReadAt, setDataReadAt] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const writing = useRef(false);
  const body = useRef<HTMLDivElement>(null);
  const subheading = useRef<HTMLHeadingElement>(null);
  const overrideEntry = useRef<HTMLButtonElement>(null);
  const userSearchInput = useRef<HTMLInputElement>(null);
  useFadingScrollbars(body);
  useEffect(() => {if (editingOverrides) userSearchInput.current?.focus(); else overrideEntry.current?.focus();}, [editingOverrides]);
  useEffect(() => {if (detail) subheading.current?.focus();}, [detail]);
  const dirty = Boolean(config && draft && (JSON.stringify(config[section].value) !== JSON.stringify(draft[section]) || JSON.stringify(numericFields(config, section)) !== JSON.stringify(numbers) || key));
  const leave = useUnsavedChanges(dirty, saving, '离开后，本页未保存的 AI 配置将不会保留。', 'ai-config-leave');
  useEffect(() => {onGuardChange(leave.request); return () => onGuardChange(null);}, [leave.request, onGuardChange]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void fetchAdminAIConfig(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setConfig(value); setDraft({models: structuredClone(value.models.value), budget: structuredClone(value.budget.value), concurrency: structuredClone(value.concurrency.value)});
      setNumbers(numericFields(value, 'models'));
    }).catch(reason => {if (!controller.signal.aborted) setError(message(reason));}).finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    if (section === 'models') return;
    const controller = new AbortController();
    setDataError(''); setDataLoading(true);
    const request = section === 'budget' ? fetchAdminAIUsage(controller.signal).then(value => {if (!controller.signal.aborted) setUsage(value);}) : fetchAdminAIQueue(controller.signal).then(value => {if (!controller.signal.aborted) setQueue(value);});
    void request.then(() => {if (!controller.signal.aborted) setDataReadAt(Date.now());}).catch(reason => {if (!controller.signal.aborted) setDataError(message(reason));}).finally(() => {if (!controller.signal.aborted) setDataLoading(false);});
    return () => controller.abort();
  }, [section, refresh]);

  const changePage = async (next: typeof pages[number]) => {
    if (next === page || !config || !(await leave.request())) return;
    setDraft({models: structuredClone(config.models.value), budget: structuredClone(config.budget.value), concurrency: structuredClone(config.concurrency.value)});
    setNumbers(numericFields(config, sections[next])); setKey(''); setError(''); setNotice(''); setEditingOverrides(false); setDetail(null); setDataReadAt(null); setPage(next);
    body.current?.scrollTo({top: 0});
  };
  const run = async (action: () => Promise<void>) => {
    if (writing.current) return;
    writing.current = true; setSaving(true); onBusy(true); setError(''); setValidationError(false); setNotice('');
    try {await action();} catch (reason) {setError(message(reason));} finally {writing.current = false; setSaving(false); onBusy(false);}
  };
  const numberField = (name: string, label: string, options: {optional?: boolean; min?: number; max?: number; integer?: boolean} = {}) => <label className="ai-config__field">{label}<input ref={element => {if (element && !options.integer) element.setCustomValidity(aiAmountError(numbers[name] ?? '', section === 'models' ? 10000 : 1000000000, Boolean(options.optional)));}} aria-label={label} inputMode={options.integer ? 'numeric' : 'decimal'} type="number" step={options.integer ? 1 : 'any'} min={options.min ?? 0} max={options.max ?? (section === 'models' ? 10000 : 1000000000)} required={!options.optional} value={numbers[name] ?? ''} placeholder={options.optional ? '未设置' : undefined} onChange={event => {if (validationError) {setError(''); setValidationError(false);} setNumbers(current => ({...current, [name]: event.target.value}));}}/></label>;
  const cancel = async () => {
    if (!config || !(await leave.request())) return;
    setDraft({models: structuredClone(config.models.value), budget: structuredClone(config.budget.value), concurrency: structuredClone(config.concurrency.value)});
    setNumbers(numericFields(config, section)); setKey(''); setError(''); setNotice('');
  };
  const save = async () => {
    if (!config || !draft || !dirty) return;
    if (section !== 'concurrency') {
      for (const amount of Object.values(numbers)) {
        const invalid = aiAmountError(amount, section === 'models' ? 10000 : 1000000000, section === 'budget');
        if (invalid) {setError(invalid); setValidationError(true); return;}
      }
    } else {
      const invalid = ([['max_running', 1, config.concurrency.value.verified_capacity ?? 1, '执行名额'], ['queue_limit', 1, 100, '总排队上限'], ['user_queue_limit', 1, 2, '每人排队上限'], ['queue_timeout_seconds', 60, 1800, '最长等待']] as const).find(([name, min, max]) => !Number.isInteger(Number(numbers[name])) || Number(numbers[name]) < min || Number(numbers[name]) > max);
      if (invalid) {setError(`请检查${invalid[3]}，返回后仍需满足原有范围。`); setValidationError(true); return;}
    }
    await run(async () => {
      const value = structuredClone(draft[section]);
      let credentialUpdated = false;
      if (section === 'models') {
        const models = value as AIConfigValues['models'];
        models.prices = Object.fromEntries(Object.keys(models.prices).map(model => [model, {input: numbers[`${model}:input`], cache: numbers[`${model}:cache`], output: numbers[`${model}:output`]}]));
        if (key.trim()) {
          const credential = await saveAICredential(key.trim());
          setConfig(current => current ? {...current, credential} : current); setKey('');
          credentialUpdated = true;
        }
      } else if (section === 'budget') {
        const budget = value as AIConfigValues['budget'];
        budget.company_monthly_cny = numbers.company_monthly_cny === '' ? null : numbers.company_monthly_cny;
        budget.user_monthly_cny = numbers.user_monthly_cny === '' ? null : numbers.user_monthly_cny;
        budget.user_overrides = Object.fromEntries(Object.keys(budget.user_overrides).map(owner => [owner, numbers[`user:${owner}`] === '' ? null : numbers[`user:${owner}`]]));
      } else Object.assign(value, Object.fromEntries(Object.entries(numbers).map(([name, amount]) => [name, Number(amount)])));
      const saved = await saveAdminAIConfig(section, config[section].revision, value).catch(reason => {
        if (credentialUpdated) throw new Error(`密钥已更新；模型配置未保存：${message(reason)}`);
        throw reason;
      });
      const updated = {...config, [section]: saved};
      // Credential may have been saved independently before this section succeeds.
      setConfig(current => current ? {...current, [section]: saved} : updated);
      setDraft(current => current ? {...current, [section]: saved.value} as AIConfigValues : current);
      setNumbers(numericFields(updated, section)); setNotice('已保存，后续运行按新设置执行。'); setRefresh(current => current + 1);
    });
  };
  const readLatest = () => run(async () => {
    const latest = await fetchAdminAIConfig();
    setConfig(latest);
    setDraft(current => current ? {...current,
      models: {...current.models, validated_models: latest.models.value.validated_models},
      concurrency: {...current.concurrency, verified_capacity: latest.concurrency.value.verified_capacity},
    } : current);
    if (section === 'concurrency' && latest.concurrency.value.verified_capacity !== undefined) {
      setNumbers(current => ({...current, verified_capacity: String(latest.concurrency.value.verified_capacity)}));
    }
    setNotice('已读取最新版本，草稿已保留，请核对后保存。');
  });
  if (loading && !config) return <div className="ai-config__state" role="status"><LoaderCircle size={20} className="ai-config__spinner"/>正在读取 AI 配置…</div>;
  if (!config || !draft) return <div className="ai-config__state"><p role="alert">{error || 'AI 配置暂时不可用。'}</p><button className="secondary-button" type="button" onClick={() => setReload(value => value + 1)}>重新读取</button></div>;
  const models = draft.models;
  const capabilities = config.model_capabilities;
  const allowed = capabilities.filter(model => models.enabled_models.includes(model.id));
  const efforts = capabilities.find(model => model.id === models.default_model)?.efforts ?? [];
  const cap = config.concurrency.value.verified_capacity ?? queue?.verified_capacity ?? 1;
  const companyLimit = config.budget.value.company_monthly_cny === null ? null : Number(config.budget.value.company_monthly_cny);
  const occupied = usage ? Number(usage.totals.cost_cny) + Number(usage.totals.pending_cny) : 0;
  const refreshStatus = <div className="ai-config__refresh"><span>{dataLoading ? '正在刷新…' : dataReadAt ? `更新于 ${new Date(dataReadAt).toLocaleTimeString('zh-CN', {hour12: false})}` : '尚未读取'}</span><button type="button" className="ai-config__text-action" disabled={dataLoading || saving} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14}/>刷新状态</button></div>;
  const openDetail = (next: 'reasoning' | 'access' | 'billing' | 'usage' | 'queue') => {setDetail(next); setEditingPrices(false); body.current?.scrollTo({top: 0});};
  const nested = editingOverrides || detail !== null;
  const nestedTitle = editingOverrides ? '个人例外额度' : detail ? {reasoning: '推理设置', access: '管理接入', billing: '模型与计费详情', usage: '用量明细', queue: '排队策略'}[detail] : '';
  const returnToPage = () => {setDetail(null); editOverrides(false); body.current?.focus();};
  const overrideCount = Object.keys(draft.budget.user_overrides).length;
  const visibleUsers = users.filter(user => `${user.display_name} ${user.username} ${user.department ?? ''}`.toLocaleLowerCase().includes(userSearch.trim().toLocaleLowerCase()));
  const editOverrides = (open: boolean) => {
    setEditingOverrides(open); setUserSearch(''); body.current?.scrollTo({top: 0});
  };
  const toggleOverride = (owner: string, enabled: boolean) => {
    const overrides = {...draft.budget.user_overrides};
    if (enabled) overrides[owner] = null; else delete overrides[owner];
    setDraft({...draft, budget: {...draft.budget, user_overrides: overrides}});
    setNumbers(current => {const next = {...current}; if (enabled) next[`user:${owner}`] = ''; else delete next[`user:${owner}`]; return next;});
  };

  return <section className="ai-config">
    {leave.confirmation}
    {nested ? <div className="ai-config__subheading"><button type="button" className="ai-config__back" disabled={saving} onClick={returnToPage}><ArrowLeft size={16}/>返回{page}</button><h2 ref={subheading} tabIndex={-1}>{nestedTitle}</h2>{editingOverrides && <p>未单独设置的用户使用个人默认额度；例外额度留空表示不设额度。</p>}</div> : <><div className="ai-config__heading"><h2>AI 配置</h2><p>统一管理模型接入、使用额度和运行名额。</p></div>
    <div className="ai-config__tabs" role="tablist" aria-label="AI 配置分类">{pages.map(item => <button key={item} id={`ai-config-tab-${sections[item]}`} type="button" role="tab" aria-selected={page === item} aria-controls="ai-config-panel" tabIndex={page === item ? 0 : -1} disabled={saving} onClick={() => void changePage(item)} onKeyDown={event => {
      const index = pages.indexOf(item);
      const next = event.key === 'ArrowRight' ? pages[(index + 1) % pages.length] : event.key === 'ArrowLeft' ? pages[(index + pages.length - 1) % pages.length] : event.key === 'Home' ? pages[0] : event.key === 'End' ? pages[pages.length - 1] : null;
      if (next) {event.preventDefault(); document.getElementById(`ai-config-tab-${sections[next]}`)?.focus();}
    }}>{item}</button>)}</div></>}
    <form className="ai-config__form" onSubmit={event => {event.preventDefault(); void save();}}>
      <div className="ai-config__scroll fading-scrollbar" ref={body} id="ai-config-panel" role={nested ? undefined : 'tabpanel'} tabIndex={0} aria-labelledby={nested ? undefined : `ai-config-tab-${section}`}>
        <fieldset disabled={saving}>
          {section === 'models' && !detail && <>
            <Card icon={<Bot size={16}/>} title="使用模型">

              <div className="ai-config__row"><strong>默认模型</strong>{allowed.length === 1 ? <span>{allowed[0].name}</span> : <WorkbenchOptionMenu label="默认模型" value={models.default_model} options={allowed.map(model => ({value: model.id, label: model.name}))} onSelect={value => {const model = capabilities.find(item => item.id === value); const supported = models.allowed_efforts.filter(effort => model?.efforts.includes(effort)); setDraft({...draft, models: {...models, default_model: value, allowed_efforts: supported.length ? supported : ['high'], default_effort: supported.includes(models.default_effort) ? models.default_effort : 'high'}});}}/>}</div>

              <button type="button" className="ai-config__entry" onClick={() => openDetail('reasoning')}><span><strong>推理设置</strong><small>默认{effortName[models.default_effort] ?? models.default_effort} · 用户可选 {models.allowed_efforts.map(effort => effortName[effort] ?? effort).join('、')}</small></span><ChevronRight size={16}/></button>
            </Card>
            <Card icon={<KeyRound size={16}/>} title="接入与维护">
              <button type="button" className="ai-config__entry" onClick={() => openDetail('access')}><span><strong>管理接入</strong><small>DeepSeek · {config.credential.configured ? '已配置' : '未配置'}{key ? ' · 有未保存的密钥' : ''}</small></span><ChevronRight size={16}/></button>
              <button type="button" className="ai-config__entry" onClick={() => openDetail('billing')}><span><strong>模型与计费详情</strong><small>价格快照、运行限制及单价维护</small></span><ChevronRight size={16}/></button>
            </Card>
          </>}
          {section === 'models' && detail === 'reasoning' && <Card icon={<Bot size={16}/>} title="默认与可选档位">
              <div className="ai-config__row"><strong>默认推理档位</strong><WorkbenchOptionMenu label="默认推理档位" value={models.default_effort} options={models.allowed_efforts.map(value => ({value, label: effortName[value] ?? value}))} onSelect={value => setDraft({...draft, models: {...models, default_effort: value}})}/></div>
              <div className="ai-config__choices"><span>允许用户选择</span>{efforts.map(effort => <label key={effort}><input type="checkbox" checked={models.allowed_efforts.includes(effort)} disabled={models.default_effort === effort} onChange={event => setDraft({...draft, models: {...models, allowed_efforts: event.target.checked ? [...models.allowed_efforts, effort] : models.allowed_efforts.filter(value => value !== effort)}})}/>{effortName[effort] ?? effort}</label>)}</div>
          </Card>}
          {section === 'models' && detail === 'access' && <>
            <Card icon={<KeyRound size={16}/>} title="DeepSeek 接入">
              <div className="ai-config__row"><div><strong>API Key</strong><p>密钥仅保存在服务端</p></div><span className="ai-config__tag">{config.credential.configured ? '已配置' : '待配置'}</span></div>
              <label className="ai-config__field">{config.credential.configured ? '更换密钥' : '填写密钥'}<input type="password" autoComplete="new-password" maxLength={256} value={key} onChange={event => setKey(event.target.value)} placeholder={config.credential.configured ? '留空保留现有密钥' : '仅保存在服务器上'}/></label>
              <div className="ai-config__test"><button type="button" className="secondary-button" disabled={!config.credential.configured || dirty || saving} onClick={() => void run(async () => {const result = await testAIConnection(models.default_model); if (!result.ok) throw new Error('模型连接测试未通过。'); setNotice('模型连接正常。'); setRefresh(value => value + 1);})}>连接测试</button><p>使用已保存配置，测试会产生少量用量并计入预算。</p></div>
            </Card>
          </>}
          {section === 'models' && detail === 'billing' && <>
            <div className="ai-config__maintenance"><p className="ai-config__note">价格配置版本 v{config.models.revision}{config.models.updated_at ? ` · 更新于 ${new Date(config.models.updated_at).toLocaleString('zh-CN')}` : ''}</p><p className="ai-config__note"><a href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing/" target="_blank" rel="noreferrer">DeepSeek 官方计价来源</a> · 当前快照，非自动同步</p><button type="button" className="secondary-button" disabled={editingPrices} onClick={() => setEditingPrices(true)}>调整计费单价</button></div>
            {allowed.map(model => <Card icon={<Bot size={16}/>} title={model.name} key={model.id}>
              {model.id in models.prices && (editingPrices ? <div className="ai-config__fields">{numberField(`${model.id}:input`, '未缓存输入')}{numberField(`${model.id}:cache`, '缓存输入')}{numberField(`${model.id}:output`, '输出')}</div> : <dl className="ai-config__details"><div><dt>未缓存输入单价</dt><dd>{numbers[`${model.id}:input`]} 元／百万 Token</dd></div><div><dt>缓存输入单价</dt><dd>{numbers[`${model.id}:cache`]} 元／百万 Token</dd></div><div><dt>输出单价</dt><dd>{numbers[`${model.id}:output`]} 元／百万 Token</dd></div></dl>)}
              <dl className="ai-config__details ai-config__runtime-details"><div><dt>上下文／自动压缩</dt><dd>{count(model.context_window)} / {count(model.auto_compact_tokens)} Token</dd></div><div><dt>工作台输出上限</dt><dd>{count(model.output_tokens)} Token</dd></div><div><dt>模型最大输出</dt><dd>{count(model.provider_max_output_tokens)} Token</dd></div></dl>
            </Card>)}
            <p className="ai-config__note">Harness {config.runtime.version || '未读取到'} · 单位：元／百万 Token。更新仅影响后续请求，费用按峰时单价预估。</p>
          </>}
          {section === 'budget' && editingOverrides && <>
            <label className="ai-config__search"><Search size={16}/><input ref={userSearchInput} type="search" aria-label="查找额度用户" placeholder="搜索姓名、账号或部门" value={userSearch} onChange={event => setUserSearch(event.target.value)}/></label>
            <p className="ai-config__note ai-config__override-count">已设置 {overrideCount} 人 · 选择用户后填写月度额度，保存后生效。</p>
            <div className="ai-config__user-list">{visibleUsers.map(user => {
              const enabled = user.id in draft.budget.user_overrides;
              return <div className="ai-config__user-row" key={user.id}><label className="ai-config__user-select"><input type="checkbox" checked={enabled} aria-label={`为 ${user.display_name}（${user.username}）设置例外额度`} onChange={event => toggleOverride(user.id, event.target.checked)}/><span><strong>{user.display_name}</strong><small>{user.username} · {user.department || '未分配部门'}</small></span></label>{enabled ? numberField(`user:${user.id}`, `${user.display_name} 月度额度（元）`, {optional: true}) : <span className="ai-config__tag">使用默认额度</span>}</div>;
            })}</div>
            {!visibleUsers.length && <EmptyState compact icon={Search} title={userSearch.trim() ? '没有匹配的用户' : '暂无可配置用户'}/>}
          </>}
          {section === 'budget' && !editingOverrides && !detail && <>
            <Card icon={<Banknote size={16}/>} title="本月预算占用" action={refreshStatus}>
              {usage ? <>
                <div className="ai-config__usage ai-config__usage--pair"><div><span>当前预算占用</span><strong>{money(occupied)}</strong></div><div><span>公司剩余额度</span><strong>{companyLimit === null ? '未设置预算' : money(Math.max(0, companyLimit - occupied))}</strong></div></div>
                <p className="ai-config__note">{usage.month} · 北京时间自然月{Number(usage.totals.pending_cny) > 0 ? ` · 含待核算 ${money(usage.totals.pending_cny)}` : ''}</p>
                {companyLimit !== null && <p className={occupied >= companyLimit ? 'ai-config__error' : 'ai-config__note'} role="status">{occupied >= companyLimit ? '已达公司额度，后续模型请求将停止。' : `已使用 ${companyLimit ? Math.round(occupied / companyLimit * 100) : 100}%${occupied >= companyLimit * .8 ? '，已达到 80% 提醒线' : ''}。`}</p>}
                <button type="button" className="ai-config__text-action" onClick={() => openDetail('usage')}>查看用量明细<ChevronRight size={14}/></button>
              </> : <p className="ai-config__note">{dataError ? '本月用量暂时不可用。' : '正在读取本月用量…'}</p>}
            </Card>
            <Card icon={<Gauge size={16}/>} title="月度预算">
              <div className="ai-config__fields ai-config__fields--pair">{numberField('company_monthly_cny', '公司总预算（元）', {optional: true})}{numberField('user_monthly_cny', '个人默认额度（元）', {optional: true})}</div>
              <p className="ai-config__note">留空不设额度；0 元停止后续请求。80% 提醒，达到额度后停止新请求，已发出的请求允许完成。</p>
            </Card>
            <Card icon={<Users size={16}/>} title="个人例外额度">
              <button ref={overrideEntry} type="button" className="ai-config__entry" onClick={() => editOverrides(true)}><span><strong>配置个人额度</strong><small>{overrideCount ? `已设置 ${overrideCount} 人` : '未设置个人例外额度'} · 其余用户使用默认额度</small></span><ChevronRight size={16}/></button>
            </Card>

          </>}
          {section === 'budget' && detail === 'usage' && usage && <>
            <Card icon={<Banknote size={16}/>} title="费用与 Token" action={refreshStatus}>
            <dl className="ai-config__details"><div><dt>预算占用</dt><dd>{money(occupied)}</dd></div><div><dt>已核算预估费用</dt><dd>{money(usage.totals.cost_cny)}</dd></div><div><dt>待核算预估</dt><dd>{money(usage.totals.pending_cny)}</dd></div><div><dt>总 Token</dt><dd>{count(usage.totals.total_tokens)}</dd></div><div><dt>输入 Token</dt><dd>{count(usage.totals.input_tokens)}</dd></div><div><dt>其中缓存命中</dt><dd>{count(usage.totals.cached_tokens)}</dd></div><div><dt>输出 Token</dt><dd>{count(usage.totals.output_tokens)}</dd></div></dl>
            <p className="ai-config__note">{usage.month} · 仅有总用量的历史请求可能没有输入与输出拆分。</p>
            </Card>
            {usage && <Card icon={<Users size={16}/>} title="用户与部门用量">
              <div className="ai-config__table-scroll"><table><thead><tr><th>用户</th><th>部门</th><th>预算占用</th><th>月度额度</th><th>Token</th></tr></thead><tbody>{usage.users.map(user => <tr key={user.owner_id}><td><strong className="ai-config__person-name">{user.display_name}</strong><small className="ai-config__cell-note">{users.find(item => item.id === user.owner_id)?.username ?? `账号已移除 · ${user.owner_id}`}</small></td><td>{user.department || '未分配'}</td><td>{money(Number(user.cost_cny) + Number(user.pending_cny))}{Number(user.pending_cny) > 0 && <small className="ai-config__cell-note">含待核算 {money(user.pending_cny)}</small>}{user.monthly_cny !== null && (Number(user.cost_cny) + Number(user.pending_cny)) >= Number(user.monthly_cny) * .8 && <span className="ai-config__quota">{Number(user.cost_cny) + Number(user.pending_cny) >= Number(user.monthly_cny) ? '已达额度' : '已达 80%'}</span>}</td><td>{user.monthly_cny === null ? '未设置' : money(user.monthly_cny)}</td><td>{count(user.total_tokens)}</td></tr>)}</tbody></table></div>
              {!usage.users.length && <EmptyState compact icon={Users} title="本月暂无模型用量"/>}
              {usage.departments.length > 0 && <div className="ai-config__table-scroll"><table><thead><tr><th>部门汇总</th><th>预算占用</th><th>Token</th></tr></thead><tbody>{usage.departments.map(department => <tr key={department.department}><td>{department.department || '未分配'}</td><td>{money(Number(department.cost_cny) + Number(department.pending_cny))}{Number(department.pending_cny) > 0 && <small className="ai-config__cell-note">含待核算 {money(department.pending_cny)}</small>}</td><td>{count(department.total_tokens)}</td></tr>)}</tbody></table></div>}
              <p className="ai-config__note">删除会话不会返还已消耗额度；旧记录缺少明细时不补造费用。</p>
            </Card>}
          </>}
          {section === 'concurrency' && !detail && <>
            <Card icon={<Gauge size={16}/>} title="当前运行与队列" action={refreshStatus}>
              {queue ? <><div className="ai-config__usage"><div><span>运行中</span><strong>{queue.items.filter(item => item.status === 'running').length}</strong></div><div><span>排队中</span><strong>{queue.queued}</strong></div><div><span>等待输入</span><strong>{queue.items.filter(item => item.status === 'waiting').length}</strong></div></div><p className="ai-config__note">当前执行名额 {queue.max_running} 个；以下时长截至最近读取时间。</p>{queue.items.length ? <div className="ai-config__table-scroll"><table><thead><tr><th>用户</th><th>状态</th><th>入队／开始时间</th><th>已等待／已开始</th></tr></thead><tbody>{queue.items.map(item => {
                const start = item.status === 'queued' ? item.queued_at : item.started_at;
                return <tr key={item.id}><td>{item.owner_name}</td><td>{item.status === 'queued' ? '排队中' : item.status === 'waiting' ? '等待输入' : '运行中'}</td><td>{start ? <><span>{item.status === 'queued' ? '入队 ' : '开始 '}</span>{new Date(start).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit'})}</> : '—'}</td><td>{queueElapsed(start, dataReadAt)}</td></tr>;
              })}</tbody></table></div> : <EmptyState compact icon={Gauge} title="暂无运行或排队"/>}</> : <p className="ai-config__note">正在读取运行状态…</p>}
            </Card>
            <Card icon={<Gauge size={16}/>} title="执行名额">

              <div className="ai-config__row"><strong>同时执行数</strong><WorkbenchOptionMenu label="同时执行数" value={numbers.max_running} options={Array.from({length: cap}, (_, index) => ({value: String(index + 1), label: `${index + 1} 个`}))} onSelect={value => setNumbers(current => ({...current, max_running: value}))}/></div>
              <p className="ai-config__note">已验证上限 {cap} 个；每人同时执行 1 个运行。</p>
              <button type="button" className="ai-config__entry" onClick={() => openDetail('queue')}><span><strong>排队策略</strong><small>总等待 {numbers.queue_limit} 个 · 每人 {numbers.user_queue_limit} 个 · 最长 {numbers.queue_timeout_seconds === '' ? '未填写' : Number(numbers.queue_timeout_seconds) / 60} 分钟</small></span><ChevronRight size={16}/></button>
            </Card>


          </>}
          {section === 'concurrency' && detail === 'queue' && <>
            <Card icon={<Users size={16}/>} title="排队规则">
              <div className="ai-config__fields">{numberField('queue_limit', '总排队上限', {min: 1, max: 100, integer: true})}{numberField('user_queue_limit', '每人排队上限', {min: 1, max: 2, integer: true})}<label className="ai-config__field">最长等待（分钟）<input aria-label="最长等待（分钟）" type="number" inputMode="decimal" step="any" min={1} max={30} required value={numbers.queue_timeout_seconds === '' ? '' : Number(numbers.queue_timeout_seconds) / 60} onChange={event => {if (validationError) {setError(''); setValidationError(false);} setNumbers(current => ({...current, queue_timeout_seconds: event.target.value === '' ? '' : String(Math.round(Number(event.target.value) * 60))}));}}/></label></div>
              <p className="ai-config__note">同一用户按提交顺序执行，不同用户轮流获得名额。等待期间可取消，不产生模型费用。</p>
            </Card>
          </>}
        </fieldset>
        {dataError && <div className="ai-config__error" role="alert">{dataError}<button type="button" className="secondary-button" disabled={saving} onClick={() => setRefresh(value => value + 1)}>重试</button></div>}
      </div>
      <footer className="ai-config__footer"><div aria-live="polite">{error ? <span className="ai-config__error" role="alert">{error}</span> : notice ? <span className="ai-config__saved"><CircleCheck size={14}/>{notice}</span> : <span>{dirty ? '有未保存的修改' : '配置已保存'}</span>}</div><div className="ai-config__actions">{error && !validationError && <button type="button" className="secondary-button" disabled={saving} onClick={() => void readLatest()}>读取最新版本</button>}<button className="secondary-button" type="button" disabled={saving || !dirty} onClick={() => void cancel()}>取消</button><button className="primary-button" type="submit" disabled={saving || !dirty}>{saving ? '处理中…' : '保存'}</button></div></footer>
    </form>
  </section>;
}
