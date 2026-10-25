(function(){"use strict";
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function say(t,k){var m=$("msg");m.textContent=t||"";m.className="msg "+(k||"")}
function api(path,method,body,again){var o={method:method||"GET",credentials:"same-origin",headers:{}};if(body){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body)}
var down=function(){throw{m:"Serveur injoignable. Vérifiez votre connexion."}};
var done=function(r){return r.json().catch(function(){throw{m:"Réponse inattendue du serveur."}}).then(function(j){if(!r.ok)throw{s:r.status,m:j.error};return j})};
return fetch(path,o).catch(down).then(function(r){
if(r.status===401&&!again){return fetch("/auth/refresh",{method:"POST",credentials:"same-origin"}).catch(down).then(function(x){return x.ok?api(path,method,body,true):done(r)})}
return done(r)})}
var ERR={invalid_input:"Vérifiez les champs : championnat, équipes, sélection et analyse sont obligatoires.",invalid_odds:"Cote invalide (entre 1,01 et 1000).",invalid_confidence:"Confiance invalide."};
function why(e){if(e.s===401)return"Vous n’êtes pas connecté. Connectez-vous d’abord sur le site (page Connexion), puis revenez ici.";if(e.s===403)return"Ce compte n’a pas les droits d’administration.";if(e.s===404)return"Cet élément a déjà été traité.";return ERR[e.m]||(e.m&&e.m.indexOf("_")<0?e.m:"Une erreur est survenue.")}
function day(d,o){return new Date(d).toLocaleString("fr-FR",o||{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}
// --- Comptes bookmaker ---
var list=$("list"),st=$("st");
function loadClaims(){say("Chargement…");list.innerHTML="";
api("/admin/claims?status="+encodeURIComponent(st.value)).then(function(d){say("");
if(!d.claims.length){list.innerHTML='<div class="empty">Aucune demande '+({pending:"en attente",approved:"validée",rejected:"refusée"})[st.value]+'.</div>';return}
list.innerHTML=d.claims.map(function(c){return '<article class="card"><div class="meta"><span>'+esc(c.display_name)+' · '+esc(c.email)+'</span><span>'+day(c.created_at)+'</span></div><div class="teams">'+esc(c.bookmaker)+'</div><div class="sel"><span>Identifiant du compte</span><b style="font-size:1.15rem;letter-spacing:.02em;word-break:break-all">'+esc(c.account_id)+'</b></div>'+(c.status==="pending"?'<div class="cta-row" style="margin-top:16px"><button class="btn" data-a="approve" data-id="'+esc(c.id)+'" data-acc="'+esc(c.account_id)+'">Valider</button><button class="btn alt" data-a="reject" data-id="'+esc(c.id)+'">Refuser</button></div>':'')+'</article>'}).join("")
}).catch(function(e){say(why(e),"err")})}
list.onclick=function(ev){var b=ev.target.closest&&ev.target.closest("button[data-a]");if(!b||b.disabled)return;var a=b.dataset.a,id=b.dataset.id;
if(a==="approve"&&!confirm("Avez-vous vérifié dans votre espace affilié que le compte « "+b.dataset.acc+" » a bien été créé avec votre code ?\n\nValider ouvre le premium pour cette personne."))return;
var body=null;if(a==="reject"){var r=prompt("Raison du refus (facultatif) :");if(r===null)return;body={reason:r}}
b.disabled=true;api("/admin/claims/"+encodeURIComponent(id)+"/"+a,"PATCH",body||{}).then(function(){say(a==="approve"?"Demande validée : l’accès premium est ouvert.":"Demande refusée : l’identifiant est libéré.","ok");loadClaims()}).catch(function(e){b.disabled=false;say(why(e),"err")})};
st.onchange=loadClaims;$("rf").onclick=loadClaims;
// --- Pronostics ---
function pcard(p){var open=p.state==="published"&&(!p.result||p.result==="pending"),lab={won:"Gagné",lost:"Perdu",void:"Annulé"}[p.result]||"";
var act=p.state==="draft"?'<button class="btn" data-a="publish" data-id="'+esc(p.id)+'">Publier</button>':open?'<button class="btn" data-a="result" data-r="won" data-id="'+esc(p.id)+'">Gagné</button><button class="btn alt" data-a="result" data-r="lost" data-id="'+esc(p.id)+'">Perdu</button><button class="btn alt" data-a="result" data-r="void" data-id="'+esc(p.id)+'">Annulé</button>':'';
return '<article class="card"><div class="meta"><span>'+esc(p.league)+' · '+day(p.kickoff_at)+'</span><span class="tag">'+(p.tier==="premium"?"Premium":"Gratuit")+' · '+(p.state==="published"?"publié":"brouillon")+(lab?" · "+lab:"")+'</span></div><div class="teams">'+esc(p.home_team)+' – '+esc(p.away_team)+'</div><div class="sel"><span>'+esc(p.selection)+'</span><span class="odds">'+Number(p.odds).toFixed(2).replace(".",",")+'</span></div>'+(act?'<div class="cta-row" style="margin-top:14px">'+act+'</div>':'')+'</article>'}
function loadPreds(){api("/admin/predictions").then(function(d){$("plist").innerHTML=d.predictions.length?d.predictions.map(pcard).join(""):'<div class="empty">Aucun pronostic pour le moment.</div>'}).catch(function(e){say(why(e),"err")})}
function send(pub){var v=function(i){return $(i).value.trim()},ko=$("ko").value?new Date($("ko").value):null;
if(!ko||isNaN(ko.getTime()))return say("Indiquez la date et l’heure du match.","err");
if(pub&&!confirm("Publier ce pronostic maintenant ? Il sera visible tout de suite."))return;
api("/admin/predictions","POST",{league:v("lg"),home_team:v("hm"),away_team:v("aw"),kickoff_at:ko.toISOString(),selection:v("sl"),odds:Number(v("od").replace(",",".")),confidence:Number($("cf").value),tier:$("tr").value,analysis:v("an"),publish:pub}).then(function(){say(pub?"Pronostic publié.":"Brouillon enregistré.","ok");$("pf").reset();loadPreds()}).catch(function(e){say(why(e),"err")})}
$("pub").onclick=function(){send(true)};$("draft").onclick=function(){send(false)};
$("plist").onclick=function(ev){var b=ev.target.closest&&ev.target.closest("button[data-a]");if(!b||b.disabled)return;var a=b.dataset.a;
if(a==="result"&&!confirm("Enregistrer le résultat « "+b.textContent+" » ?\nIl sera visible publiquement dans la page Résultats."))return;
b.disabled=true;api("/admin/predictions/"+encodeURIComponent(b.dataset.id)+"/"+a,"PATCH",a==="result"?{result:b.dataset.r}:{}).then(function(){say(a==="publish"?"Pronostic publié.":"Résultat enregistré.","ok");loadPreds()}).catch(function(e){b.disabled=false;say(why(e),"err")})};
// --- Onglets ---
var tabs=document.querySelectorAll("[data-tab]");
function show(t){$("t-claims").hidden=t!=="claims";$("t-preds").hidden=t!=="preds";[].forEach.call(tabs,function(b){b.setAttribute("aria-pressed",b.dataset.tab===t)});say("");if(t==="claims")loadClaims();else loadPreds()}
[].forEach.call(tabs,function(b){b.onclick=function(){show(b.dataset.tab)}});
show("claims");
})();