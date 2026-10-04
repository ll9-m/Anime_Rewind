function lum(hex){
  const h=hex.replace("#",""); const c=h.length===3?h.split("").map(x=>x+x).join(""):h;
  const v=[0,2,4].map(i=>parseInt(c.substr(i,2),16)/255)
    .map(x=>x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4));
  return 0.2126*v[0]+0.7152*v[1]+0.0722*v[2];
}
function ratio(a,b){ const l1=lum(a),l2=lum(b); const [hi,lo]=l1>l2?[l1,l2]:[l2,l1]; return (hi+0.05)/(lo+0.05); }
const themes={
  dark:  {bg:"#0d1117",panel:"#141a22",panel2:"#1a222c",text:"#e8eef5",text2:"#b3c0cd",muted:"#8b9aab",accent:"#22d3ee"},
  light: {bg:"#eceff3",panel:"#fbfcfd",panel2:"#f2f5f8",text:"#111820",text2:"#3a4756",muted:"#5d6b7a",accent:"#0b7186"},
  glass: {bg:"#0f151c",panel:"#1a222c",panel2:"#22303d",text:"#eaf1f8",text2:"#c1cfdd",muted:"#9fb0c1",accent:"#22d3ee"}
};
let bad=0;
for(const [tn,t] of Object.entries(themes)){
  console.log("\n["+tn+"]");
  for(const [role,fg] of [["text","text"],["text-2","text2"],["muted","muted"],["accent","accent"]]){
    const onPanel=ratio(t[fg],t.panel), onBg=ratio(t[fg],t.bg);
    // 正文需 ≥4.5，大字(≥24px或≥18.66px bold) 需 ≥3
    const need = role==="muted" ? 4.5 : 4.5;
    const ok = onPanel>=need && onBg>=need;
    if(!ok) bad++;
    console.log("  "+role.padEnd(7)+" on panel "+onPanel.toFixed(2)+"  on bg "+onBg.toFixed(2)+"  "+(ok?"PASS":"FAIL"));
  }
}
if(bad){console.error("\n"+bad+" 项未达 WCAG AA 4.5:1");process.exit(1);}
console.log("\n全部通过 WCAG AA (≥4.5:1)");
