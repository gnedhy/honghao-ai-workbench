import assert from "node:assert/strict";
import test from "node:test";
import { adoptionExceptions, decimalText, defaultParameters, draftItem, patchItems, pendingProductIds, productSourceText, quoteDraftItems, quoteListStatus, quoteTrendPoints, type Batch, type Item, type Quote } from "../src/workbenches/salesModel.ts";

test("报价草稿沿用保存成本，保留隐藏已采用输入、手填零价和单项例外", () => {
 const product={id:"A",code:"A",name:"A",source:"research",department:"研发五部",status:"ready",latest_cost:"4",inventory_cost:"12",special_allocation:false,source_version:"1"};
 const frozen:Item={product_id:"A",external_name:"原内编",cost_basis:"latest",parameters:{freight:"0.3",profit:"1.2"},final_price:"6.92",pricing_reasons:["客户议价"],pricing_note:"原依据",reference_prices:{customer:"8"},product,adopted:true};
 const loaded=draftItem({...product,latest_cost:"12"},"domestic_direct",frozen);
 assert.equal(loaded.product.latest_cost,"4");
 const pending=draftItem({...product,id:"B"},"domestic_direct");
 pending.manual=true; pending.final_price="0";
 const rows=quoteDraftItems([frozen,{...frozen,product_id:"removed",adopted:false}],[pending]);
 assert.deepEqual(rows.map(row=>row.product_id),["A","B"]);
 assert.equal(rows[0].final_price,"6.92"); assert.deepEqual(rows[0].parameters,frozen.parameters);
 assert.equal(rows[0].external_name,"原内编"); assert.deepEqual(rows[0].reference_prices,{customer:"8"});
 assert.equal(rows[1].final_price,"0");
 const invalidEdit={...loaded,manual:true,final_price:"999",parameters:{freight:"99"}};
 assert.deepEqual(quoteDraftItems([frozen],[invalidEdit])[0],rows[0]);
});

test("报价趋势保留真实零价，不把缺价画成零，并跳过完全无价记录", () => {
 const item=(normal_price:string|null,final_price:string|null):Item=>({product_id:"A",external_name:"",cost_basis:"latest",parameters:{},final_price,pricing_reasons:[],pricing_note:"",result:normal_price===null?null:{normal_price,break_even_price:null}});
 const row=(id:string,value:Item):Quote=>({id,batch_id:"B",batch_name:"报价",product_id:"A",version:1,status:"active",created_at:`2026-09-22T0${id}:00:00`,actor_id:"U",mode:"domestic_direct",customer_name:"客户",customer_code:"K1",salesperson:"销售",item:value});
 const points=quoteTrendPoints([row("1",item(null,"8.20")),row("2",item("0.00",null)),row("3",item(null,null))],"A","domestic_direct","2026-09-21","2026-09-23");
 assert.deepEqual(points.map(({reference,adopted})=>({reference,adopted})),[{reference:null,adopted:8.2},{reference:0,adopted:null}]);
 assert.equal(quoteTrendPoints([row("3",item(null,null))],"A","domestic_direct","2026-09-21","2026-09-23").length,0);
});
test("批量参数仅覆盖所选可编辑产品的修改字段，保留例外和手填价并使旧测算失效", () => {
 const row=(id:string,adopted=false,reason=""):Item=>({product_id:id,external_name:"产品",cost_basis:"latest",parameters:{freight:"0.3",profit:"1.2"},final_price:"8.60",pricing_reasons:["客户议价"],pricing_note:"",adopted,adjustment_reason:reason,result:{normal_price:"8.20",break_even_price:"7.45"},trial_id:"old",manual_price_confirmed:true});
 const source=[row("A"),row("B",true),row("C",true,"客户重新议价"),row("D")];
 const result=patchItems(source,["A","B","C"],{}, {freight:"0.5"});
 for(const index of [0,2]) {assert.equal(result[index].parameters.freight,"0.5");assert.equal(result[index].parameters.profit,"1.2");assert.equal(result[index].final_price,"8.60");assert.equal(result[index].result,null);assert.equal(result[index].trial_id,null);assert.equal(result[index].manual_price_confirmed,false);}
 assert.equal(result[1],source[1]);assert.equal(result[3],source[3]);assert.equal(source[0].parameters.freight,"0.3");
});

test("成本来源状态区分更新失败、完全缺价和单列回退，零价不算缺失", async () => {
 const { costStatus } = await import("../src/workbenches/salesModel.ts");
 const product={id:"A",code:"A",name:"A",source:"research",department:"研发五部",status:"ready",latest_cost:"0",inventory_cost:"2",special_allocation:false,source_version:"1"};
 assert.equal(costStatus(product),"正式成本");
 assert.equal(costStatus({...product,status:"failed"}),"核算失败");
 assert.equal(costStatus({...product,status:"updating"}),"核算更新中");
 assert.equal(costStatus({...product,latest_cost:null,inventory_cost:null}),"缺少可用成本");
 assert.equal(costStatus({...product,inventory_cost:null}),"部分缺价已回退");
 assert.equal(costStatus({...product,latest_cost:null}),"部分缺价已回退");
});

test("未定采购价显示真实状态，内部成本指纹不进入页面", () => {
 const product={id:"P",code:"CF1111",name:"CF1111",source:"procurement",department:"采购",status:"ready",latest_cost:null,inventory_cost:"24",special_allocation:true,source_label:"采购原料价格",source_version:"a".repeat(64)};
 assert.equal(productSourceText(product),"暂无正式采购价 · 库存价可用");
 assert.equal(productSourceText({...product,inventory_cost:null}),"暂无正式采购价 · 无可用库存价");
 assert.equal(productSourceText({...product,latest_cost:"12",source_version:"采购价 v21",source_date:"2026-09-11T00:00:00"}),"采购原料价格 · 采购价 v21 · 2026-09-11");
});

test("报价参考按最新优先成本计算三类报价，特殊公摊产品不伪造参考价", async () => {
 const { quoteReference } = await import("../src/workbenches/salesModel.ts");
 const product={id:"A",code:"A",name:"A",source:"research",department:"研发五部",status:"ready",latest_cost:"4.99",inventory_cost:"5.10",special_allocation:false,source_version:"1"};
 assert.deepEqual(quoteReference(product),{direct:8.22,intermediary:7.84,export:8.5});
 assert.equal(quoteReference(product,"latest",{allocation:"1",tax:"1.09",reverse:"1.04"}).intermediary,8.47);
 assert.deepEqual(quoteReference({...product,special_allocation:true}),{direct:null,intermediary:null,export:8.5});
 const inventoryOnly={...product,source:"procurement",latest_cost:null,inventory_cost:"24",special_allocation:true,source_version:"a".repeat(64)};
 assert.deepEqual(quoteReference(inventoryOnly),{direct:null,intermediary:null,export:30.36});
 assert.equal(defaultParameters({...inventoryOnly,special_allocation:false},"domestic_direct").allocation,"1.8");
 assert.deepEqual(quoteReference({...inventoryOnly,inventory_cost:null}),{direct:null,intermediary:null,export:null});
 assert.deepEqual(quoteReference({...product,source:"procurement",inventory_cost:null},"inventory"),quoteReference({...product,source:"procurement",inventory_cost:null},"latest"));
 assert.deepEqual(quoteReference({...product,source:"procurement",inventory_cost:"0"},"inventory"),quoteReference({...product,source:"procurement",inventory_cost:"0"},"latest"));
});

test("客户报价单按待采用、部分采用、已采用和已作废归类", () => {
 const item=(id:string,extra:Partial<Item>={}):Item=>({product_id:id,external_name:"",cost_basis:"latest",parameters:{},final_price:null,pricing_reasons:[],pricing_note:"",...extra});
 const batch=(items:Item[]):Batch=>({id:"B",owner_id:"U",revision:1,name:"报价",mode:"domestic_direct",customer_name:"客户",customer_code:"K1",uncoded:false,salesperson:"销售",items,created_at:"2026-09-22",updated_at:"2026-09-22",adjusted:false});
 const record=(product_id:string,status:Quote["status"]="active"):Quote=>({id:product_id,batch_id:"B",batch_name:"报价",product_id,version:1,status,created_at:"2026-09-22",actor_id:"U",mode:"domestic_direct",customer_name:"客户",customer_code:"K1",salesperson:"销售",item:item(product_id)});
 assert.equal(quoteListStatus(batch([item("A")]),[]),"pending");
 assert.equal(quoteListStatus(batch([item("A",{adopted:true}),item("B")]),[record("A")]),"partial");
 assert.equal(quoteListStatus(batch([item("A",{adopted:true})]),[record("A")]),"adopted");
 assert.equal(quoteListStatus(batch([item("A",{adopted:true,voided:true})]),[record("A","void")]),"void");
});

test("默认报价参数随客户类型与成本口径生成", () => {
 const product={id:"A",code:"A",name:"A",source:"research",department:"研发五部",status:"ready",latest_cost:"4.99",inventory_cost:"10",special_allocation:false,source_version:"1"};
 assert.equal(defaultParameters(product,"domestic_direct").allocation,"0.5");
 assert.equal(decimalText(".5"),"0.5");
 assert.equal(decimalText("."),".");
 assert.equal(defaultParameters(product,"domestic_intermediary","inventory").allocation,"1.2");
 assert.equal(defaultParameters(product,"domestic_intermediary").tax,"1.09");
 assert.equal(defaultParameters({...product,special_allocation:true},"domestic_direct").allocation,null);
});

test("部分采用报价只保存并采用待处理产品", () => {
 assert.deepEqual(pendingProductIds([
  {product_id:"A",adopted:true},
  {product_id:"B",adopted:false},
  {product_id:"C",adopted:true,adjustment_reason:"客户重新议价"},
 ]),["B","C"]);
});

test("采用前只提示待采用产品的过期成本和低于盈亏平衡价", () => {
 const product={id:"A",code:"A",name:"A",source:"research",department:"研发五部",status:"ready",latest_cost:"4.99",inventory_cost:"5.10",special_allocation:false,source_version:"1"};
 const row=(id:string,final_price:string):Item=>({product_id:id,external_name:"",cost_basis:"latest",parameters:{},final_price,pricing_reasons:[],pricing_note:"",product:{...product,id,code:id},result:{normal_price:"8.22",break_even_price:"7.45"}});
 const items=[row("A","8.22"),row("B","7.44"),row("C","7.00")];
 const live=[Object.fromEntries(Object.entries(product).reverse()) as typeof product,{...product,id:"B",code:"B",latest_cost:"5.20"},{...product,id:"C",code:"C",latest_cost:"6.00"}];
 assert.deepEqual(adoptionExceptions(items,live,["A"]),{stale:[],belowBreakEven:[]});
 const checks=adoptionExceptions(items,live,["A","B"]);
 assert.deepEqual(checks.stale.map(item=>item.product_id),["B"]);
 assert.deepEqual(checks.belowBreakEven.map(item=>item.product_id),["B"]);
});
