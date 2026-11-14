'use strict';
((root,factory)=>{
  const api=factory();
  if(typeof module==='object' && module.exports)module.exports=api;
  else root.InMomentQuoteText=api;
})(typeof window==='object'?window:globalThis,()=>{
  const limits=Object.freeze({quotes:8,perQuote:10000,total:40000});
  const pairs=[['```','```'],['**','**'],['__','__'],['~~','~~'],['`','`'],['{','}'],['(',')'],['[',']'],['（','）'],['｛','｝'],['【','】'],['「','」'],['『','』'],['《','》'],['〈','〉'],['“','”'],['‘','’'],['"','"'],["'","'"]];
  function outerPair(text,left,right){
    if(text.length<left.length+right.length || !text.startsWith(left) || !text.endsWith(right))return false;
    if(left===right || left.length!==1)return true;
    let depth=0;
    for(let i=0;i<text.length;i++){
      if(text[i]===left)depth++;
      else if(text[i]===right){depth--;if(depth===0 && i!==text.length-1)return false;if(depth<0)return false;}
    }
    return depth===0;
  }
  function lineText(value){
    let text=value.trim();
    for(let i=0;i<32;i++){
      const before=text;
      text=text.replace(/^(?:>[ \t]*)+/u,'').trim();
      const bullet=/^[-*][ \t]+(.*)$/u.exec(text);
      // A unary sign or a formula at the start of a line belongs to its content.
      if(bullet && !/^(?:\d|[A-Za-z]\w*[ \t]*[=+*/^<>-])/u.test(bullet[1]))text=bullet[1].trim();
      text=text.replace(/^[•●▪▫◆◇▸►✦✧]+[ \t]*/u,'').trim();
      for(const[left,right]of pairs)if(outerPair(text,left,right)){text=text.slice(left.length,-right.length).trim();break;}
      if(text===before)break;
    }
    if(/^[─━═—–\u002d_*~`=•●◆◇✦✧\s]{2,}$/u.test(text))return'';
    return text;
  }
  function clean(value){
    if(typeof value!=='string')return'';
    return value.replace(/\u200b/gu,' ').replace(/[\ufeff\u2060]/gu,'').split(/\r\n?|\n|\u2028|\u2029/u).map(lineText).filter(Boolean).join(' ').replace(/\s+/gu,' ').trim();
  }
  return Object.freeze({clean,limits});
});
