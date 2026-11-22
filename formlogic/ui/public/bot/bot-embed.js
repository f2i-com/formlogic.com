/*! bot.computer | Copyright 2026 f2i.com | Apache-2.0 | https://github.com/f2i-com/bot/blob/main/THIRD-PARTY-NOTICES.md */
(()=>{var si=Object.defineProperty;var rs=e=>{throw TypeError(e)};var ri=(e,t,a)=>t in e?si(e,t,{enumerable:!0,configurable:!0,writable:!0,value:a}):e[t]=a;var Ga=(e,t,a)=>ri(e,typeof t!="symbol"?t+"":t,a),tn=(e,t,a)=>t.has(e)||rs("Cannot "+a);var ot=(e,t,a)=>(tn(e,t,"read from private field"),a?a.call(e):t.get(e)),pa=(e,t,a)=>t.has(e)?rs("Cannot add the same private member more than once"):t instanceof WeakSet?t.add(e):t.set(e,a),Sa=(e,t,a,s)=>(tn(e,t,"write to private field"),s?s.call(e,a):t.set(e,a),a),F=(e,t,a)=>(tn(e,t,"access private method"),a);var ct=Math.PI*2,an=[{id:"rest",label:"Rest",duration:0},{id:"wave",label:"Wave",duration:3.6},{id:"walk",label:"Walk",duration:1.16},{id:"dance",label:"Dance",duration:2.18},{id:"stretch",label:"Stretch",duration:5.6},{id:"squat",label:"Squat",duration:3.4}],to=Object.fromEntries(an.map(({id:e,duration:t})=>[e,t]));function ao(e,t){let a=e%t/t;return a<0?a+1:a}var yt=(e,t,a=2)=>Math.max(0,Math.cos(ct*(e-t)))**a;function ii(e){let t=ao(e,to.wave),a=1-.57*yt(t,.79,5),s=a*Math.sin(ct*3*t),n=a*Math.cos(ct*3*t);return{rightArmLift:22+60*a+8*s,rightShoulder:5+8*a+4*n,rightArmRoll:26+57*a-11*s,rightElbow:31+53*a+14*s,rightWristBend:13*n,rightWristTurn:35*a+9*s,leftArmLift:5+3*a,leftShoulder:-4+2*Math.cos(ct*t),leftElbow:8+4*a,torsoTurn:-4*a+1.7*s,torsoLean:-3.4*a,headTurn:8*a-2.5*s,headTilt:4*a,headNod:3.5*yt(t,.8),rootY:.014*Math.sin(ct*t)}}function li(e){let t=ao(e,to.walk),a=Math.cos(ct*t),s=Math.sin(ct*t),n=l=>4+12*yt(l,.105,4)+52*yt(l,.66,2.5),r=l=>3+24*Math.cos(ct*l),i=l=>{let p=-10*yt(l,.01,3)+27*yt(l,.5,3)-7*yt(l,.83,5);return Math.min(43,Math.max(-31,n(l)-r(l)-p))};return{leftHip:r(t),rightHip:r(t+.5),leftKnee:n(t),rightKnee:n(t+.5),leftAnkleFlex:i(t),rightAnkleFlex:i(t+.5),leftShoulder:-18*a-3*s,rightShoulder:18*a+3*s,leftArmLift:4,rightArmLift:4,leftElbow:15-7*a,rightElbow:15+7*a,torsoTurn:5.8*a,torsoPitch:3.2+1.3*Math.cos(2*ct*t),headTurn:-3.1*a,headNod:-2-1.6*Math.cos(2*ct*t),torsoLean:-1.9*s,rootSway:.048*s,groundFeet:1}}function ci(e){let t=ao(e,to.dance),a=Math.sin(ct*t),s=Math.cos(ct*t),n=.5+.5*Math.cos(2*ct*t-.32),r=Math.sin(ct*t-.19),i=Math.sin(ct*t-.68);return{leftArmLift:43+32*r,rightArmLift:43-32*r,leftShoulder:14-18*s,rightShoulder:14+18*s,leftArmRoll:31+26*r,rightArmRoll:31-26*r,leftElbow:51+31*i,rightElbow:51-31*i,leftHip:9+12*a+5*n,rightHip:9-12*a+5*n,leftHipOut:4+16*yt(t,.25),rightHipOut:4+16*yt(t,.75),leftKnee:8+14*n+22*yt(t,.24),rightKnee:8+14*n+22*yt(t,.74),torsoTurn:13*s,torsoLean:6.7*a,torsoPitch:2+4*n,headTurn:-9*s+3*Math.sin(2*ct*t),headTilt:-4*a,headNod:-2+6*n,leftHipTwist:9*yt(t,.25,3),rightHipTwist:9*yt(t,.75,3),leftAnkleFlex:4+9*n-10*yt(t,.25,3),rightAnkleFlex:4+9*n-10*yt(t,.75,3),rootSway:-.17*a,groundFeet:1}}function hi(e){let t=ao(e,to.stretch),a=Math.sin(ct*t+.92),s=.5+.5*a,n=1-s;return{leftArmLift:24+132*s,rightArmLift:24+132*n,leftElbow:50-43*s,rightElbow:50-43*n,leftArmRoll:28+34*s,rightArmRoll:28+34*n,leftShoulder:9-12*s,rightShoulder:9-12*n,leftWristBend:9-16*s,rightWristBend:9-16*n,torsoLean:14*a,torsoPitch:-4,headNod:-9-4*a*a,headTilt:-7*a,headTurn:12*a}}function pi(e){let t=ao(e,to.squat),a=.5+.5*Math.cos(ct*t),s=a*a*(3-2*a),n=5+69*s,r=8+91*s;return{leftHip:n,rightHip:n,leftKnee:r,rightKnee:r,leftAnkleFlex:r-n,rightAnkleFlex:r-n,plantFeet:1,torsoPitch:3+23*s,headNod:-2-19*s,leftShoulder:4+62*s,rightShoulder:4+62*s,leftArmLift:4+6*s,rightArmLift:4+6*s,leftElbow:9+12*s,rightElbow:9+12*s}}function on(e,t=0){let a=Number.isFinite(t)?t:0;switch(e){case"wave":return ii(a);case"walk":return li(a);case"dance":return ci(a);case"stretch":return hi(a);case"squat":return pi(a);default:return{}}}var nn=an.filter(({duration:e})=>e>0),ui={walk:4,dance:2},ls=new Map(nn.map(({id:e,duration:t})=>[e,Math.round(t*(ui[e]||1)*1e3)])),sn=globalThis.matchMedia?.("(prefers-reduced-motion: reduce)"),di=Math.PI*2;function rn(e){return ls.get(e)||0}function is(e){let t=Math.max(0,Math.min(e,1));return t*t*(3-2*t)}function cs(e,t,a,s){if(!ls.has(t))return;let n=hs(e,a);e.bodyMotion={id:t,start:a,end:a+s,from:n}}function hs(e,t,a=sn?.matches){let s=e?.bodyMotion;if(!s||t<s.start||t>=s.end)return null;let n=t-s.start,r=s.end-t,i=on(s.id,a?.2:n/1e3);if(a)return i;let l=is(n/180),p=is(r/240);for(let h of Object.keys(i))i[h]*=p;if(s.id==="walk"){let h=n/(s.end-s.start),c=di*h;i.rootX=.56*(1-Math.cos(c)),i.rootZ=.56*Math.sin(c),i.rootYaw=360*h}if(l<1){let h=s.from||{};for(let c of new Set([...Object.keys(h),...Object.keys(i)])){let o=h[c]||0,d=(i[c]||0)-o;c==="rootYaw"&&(d-=360*Math.round(d/360)),i[c]=o+d*l}}return i}function ln(e,t,a=sn?.matches){let s=e.guideTravel;if(s){let r=on("walk",a?.2:s.elapsed*1.28);for(let i of Object.keys(r))r[i]*=s.stride;return r.rootYaw=s.facing*(68-44*s.point),r}let n=hs(e,t,a);return!e.tourPointing||!e.guideDirection?n:{...n,rootX:0,rootZ:0,rootYaw:24*e.guideDirection.x}}function cn(e,t){let a=e.guideDirection;if(!a)return null;let s=e.tourPointing||e.guideTravel;if(!s&&(t||["thumbsup","think","shrug"].includes(e.emote)))return null;let n=Math.atan2(-a.y,Math.abs(a.x));return{side:a.x<0?-1:1,elevation:Math.max(s?-1.5:-.95,Math.min(s?1.5:1.12,n)),weight:e.guideTravel?.point??1}}function hn(e){let t=e?.x||0;return Math.sign(t)*Math.min(1,Math.max(0,(Math.abs(t)-.25)/.6))}function ps(e,t,{reducedMotion:a=sn?.matches,framing:s}={}){let n=ln(e,t,a),r=n||{};if(r.rootX!==void 0){let u=s==="bust"||s==="portrait"?.22:s==="half"?.65:1;r.rootX*=u,r.rootZ*=u}let i=e.x||{},l=t/1e3,p=!a&&e.idleLife!==!1?Math.sin(l*1.9):0,h=a?1:Math.sin(l*11),c=a?1:Math.sin(l*13),o=a?0:Math.abs(Math.sin(l*15));r.headTurn=(r.headTurn||0)+e.lookX*10+i.shake*c*18,r.headTilt=(r.headTilt||0)+i.tilt*11,r.headNod=(r.headNod||0)+e.lookY*6+i.nod*h*9+i.bow*7+e.energy*2,r.torsoPitch=(r.torsoPitch||0)+i.bow*22,r.rootY=(r.rootY||0)+p*.012+i.bounce*o*.055;for(let u of["left","right"])r[u+"ArmLift"]=(r[u+"ArmLift"]||0)+i.shrug*30,r[u+"Elbow"]=(r[u+"Elbow"]||0)+i.shrug*60;r.thumbUp=i.thumbUp,r.rightShoulder=(r.rightShoulder||0)+i.thumbUp*32+i.think*40,r.rightElbow+=i.thumbUp*92+i.think*120,r.rightArmRoll=(r.rightArmRoll||0)-i.think*30,r.rightWristTurn=(r.rightWristTurn||0)+i.thumbUp*18;let d=cn(e,n);if(d){let u=d.side>0?"left":"right",m=!!(e.tourPointing||e.guideTravel);if(m&&u==="right"&&(e.bodyMotion?.id==="wave"||i.thumbUp||i.think)){for(let E of["ArmLift","Shoulder","Elbow","ArmRoll","WristTurn","WristBend"])r["left"+E]=r["right"+E]||0;r.leftThumbUp=r.thumbUp,r.thumbUp=0}let g=d.elevation*180/Math.PI,f={ArmLift:(m?80:78)+g,Elbow:m?10:26,Shoulder:m?8:15,WristTurn:m?32:50,WristBend:m?-24:0,ArmRoll:0};for(let[E,y]of Object.entries(f)){let w=r[u+E]||0;r[u+E]=w+(y-w)*d.weight}m&&(r[u+"Point"]=d.weight)}return{pose:r,movementSpace:!!(n&&!e.guideTravel&&!e.tourPointing),presenting:!!e.guideDirection,pointingPan:hn(e.guideDirection)}}var ms=[{id:"side_sweep",label:"Studio Side-Sweep"},{id:"long_waves",label:"Long Flowing Waves"},{id:"sleek_bob",label:"Sleek Concierge Bob"},{id:"quiff",label:"Textured Quiff"},{id:"curly_halo",label:"Curly Crown"},{id:"pixie",label:"Modern Pixie Crop"},{id:"updo_bun",label:"Poised High Bun"},{id:"shoulder_lob",label:"Shoulder Lob"},{id:"long_straight",label:"Long & Straight"},{id:"ponytail",label:"Ponytail"},{id:"afro",label:"Afro"},{id:"braids",label:"Twin Braids"},{id:"pigtails",label:"Pigtails"},{id:"space_buns",label:"Space Buns"},{id:"mohawk",label:"Mohawk"},{id:"buzz",label:"Clean Buzz Fade"},{id:"none",label:"Smooth / Bald"}],pn=[{id:"blazer",label:"Concierge Blazer"},{id:"suit_tie",label:"Executive Suit & Tie"},{id:"sweater",label:"Studio Crewneck"},{id:"turtleneck",label:"Architect Turtleneck"},{id:"hoodie",label:"Startup Hoodie"},{id:"vest",label:"Support Vest & Shirt"},{id:"polo",label:"Polo Shirt"},{id:"scoop",label:"Scoop-Neck Top"},{id:"apron",label:"Barista Apron"},{id:"tee",label:"Graphic Tee"},{id:"shirt",label:"Button-Up Shirt"},{id:"cardigan",label:"Cozy Cardigan"},{id:"jacket",label:"Zip Jacket"},{id:"rugby_shirt",label:"Striped Rugby Shirt"},{id:"field_overshirt",label:"Field Overshirt"},{id:"track_jacket",label:"Track Jacket"},{id:"cyber",label:"Android Chassis"}],fs=[{id:"none",label:"None"},{id:"classic",label:"Studio Frames"},{id:"round",label:"Round Wire"},{id:"bold",label:"Bold Horn-Rim"},{id:"cat_eye",label:"Cat-Eye"},{id:"aviator",label:"Aviators"},{id:"shades",label:"Tinted Shades"},{id:"visor",label:"Holo Visor"}];var gs=[{id:"none",label:"None"},{id:"beanie",label:"Beanie"},{id:"cap",label:"Cap"},{id:"headband",label:"Headband"},{id:"beret",label:"Beret"},{id:"headphones",label:"Headphones"},{id:"headscarf",label:"Headscarf"},{id:"bow",label:"Hair Bow"},{id:"flower",label:"Flower"},{id:"tiara",label:"Tiara"},{id:"fedora",label:"Fedora"},{id:"chef",label:"Chef's Hat"}];var Es=[{id:"wave",label:"Wave"},{id:"smile",label:"Smile"},{id:"wink",label:"Wink"},{id:"nod",label:"Nod"},{id:"shake",label:"Shake head"},{id:"laugh",label:"Laugh"},{id:"think",label:"Think"},{id:"surprised",label:"Surprised"},{id:"shrug",label:"Shrug"},{id:"thumbsup",label:"Thumbs up"},{id:"tilt",label:"Tilt head"},{id:"bow",label:"Bow"},...nn.filter(({id:e})=>e!=="wave").map(({id:e,label:t})=>({id:e,label:t})),{id:"rest",label:"Rest"}],zt={framing:"half",stageShape:"card",bgStyle:"studio_dark",bgColor:"#141b2d",bgAccent:"#2b6cb0",haloGlow:!0,bodyScale:1,headScale:1,neckLength:1,neckWidth:.95,shoulderWidth:.96,shoulderSlope:.08,chestWidth:.94,waistWidth:.8,hipWidth:.94,torsoLength:1,armThickness:.94,posture:"welcoming",genderStyle:"feminine",headWidth:.97,headHeight:1,cheekboneWidth:1.02,jawWidth:.9,chinLength:0,chinRoundness:.65,earSize:1,earStyle:"human",skinColor:"#f1c6b0",blushIntensity:.24,synthFinish:0,eyeSize:1.04,eyeSpacing:1,eyeTilt:.06,irisColor:"#3b82a6",lashStyle:"lush",browThickness:.92,browArch:.22,noseLength:1,noseWidth:.96,mouthWidth:.98,lipFullness:1.08,lipColor:"#d6687c",hairStyle:"long_waves",hairColor:"#3c2734",hairHighlight:"#7b546c",facialHair:"none",outfitStyle:"blazer",outfitPrimary:"#1e2f4d",outfitSecondary:"#f4f6fb",outfitAccent:"#38bdf8",glasses:"none",glassesColor:"#1f2430",headsetMic:!0,nameBadge:!0,restSmile:0,browMood:0,eyeOpen:0,freckles:0,eyeshadow:0,eyeshadowColor:"#7a5c8f",browColor:"",earrings:"none",earringColor:"#e6c35c",headwear:"none",headwearColor:"#b4452f",neckwear:"none",neckwearColor:"#d9a441",fringe:!1,ageLines:0,beautyMark:!1,dimples:0,eyeliner:0,noseStud:!1,irisColor2:"",brooch:"none",broochColor:"#e6c35c"},Os=[{id:"aria",persona:"friendly",name:"Aria",role:"Website Concierge",tagline:"Classic SitePal hostess with headset & warm soprano voice",voicePreset:"arctic_slt",voiceOverrides:{gender:"female",pitchHz:192,speed:1.05,expressiveness:1.08,warmth:.66},greeting:"[cheerful] Hi! [wave] Welcome to our website! I'm Aria, your virtual companion. Click below to ask me any question! [wink]",avatar:{...zt,earrings:"studs",restSmile:.25}},{id:"marcus",persona:"professional",name:"Marcus",role:"Executive Advisor",tagline:"Broad-shouldered tailored suit & confident baritone",voicePreset:"arctic_bdl",voiceOverrides:{gender:"male",pitchHz:112,speed:1.04,expressiveness:1,warmth:.62},greeting:"Hello and welcome! [nod] I'm Marcus. I can walk you through our plans, features, or technical documentation anytime.",avatar:{...zt,browMood:-.2,restSmile:.15,genderStyle:"masculine",bgStyle:"sky_glass",neckWidth:1.08,shoulderWidth:1.16,shoulderSlope:.02,chestWidth:1.12,waistWidth:.96,hipWidth:.96,armThickness:1.08,posture:"presenter",headWidth:1.03,jawWidth:1.08,chinLength:.08,chinRoundness:.82,skinColor:"#cf936e",blushIntensity:.1,eyeSize:.96,eyeTilt:0,irisColor:"#4f6d4a",lashStyle:"subtle",browThickness:1.24,browArch:.08,noseWidth:1.06,mouthWidth:1.04,lipFullness:.9,lipColor:"#ad686d",hairStyle:"quiff",hairColor:"#232631",hairHighlight:"#4c546b",facialHair:"stubble",outfitStyle:"suit_tie",outfitPrimary:"#1b263b",outfitSecondary:"#f8fafc",outfitAccent:"#2563eb",glasses:"none",headsetMic:!1}},{id:"chloe",persona:"bubbly",name:"Chloe",role:"Product Support",tagline:"Friendly studio sweater, round frames & lively voice",voicePreset:"bright",voiceOverrides:{gender:"female",pitchHz:214,speed:1.08,expressiveness:1.18,warmth:.72},greeting:"[happy] Hey there! [wave] Need a quick hand finding something? Just type a question and I'll answer right away! [smile]",avatar:{...zt,freckles:.55,restSmile:.35,browMood:.3,bgStyle:"warm_cream",shoulderWidth:.92,waistWidth:.78,posture:"welcoming",headWidth:.99,jawWidth:.92,chinRoundness:.72,skinColor:"#f6d8c8",blushIntensity:.3,eyeSize:1.1,irisColor:"#7c5836",lashStyle:"lush",hairStyle:"sleek_bob",hairColor:"#7c3f2c",hairHighlight:"#b86b4d",lipColor:"#db6b7b",outfitStyle:"sweater",outfitPrimary:"#0f766e",outfitSecondary:"#ffffff",outfitAccent:"#5eead4",glasses:"round",glassesColor:"#43342b",headsetMic:!0}},{id:"viktor",persona:"calm",name:"Viktor",role:"Solutions Architect",tagline:"Minimalist turtleneck, sculpted beard & resonant voice",voicePreset:"arctic_rms",voiceOverrides:{gender:"male",pitchHz:94,speed:1,expressiveness:.96,chestResonance:.75},greeting:"[calm] Greetings. I'm Viktor. Ask me how our self-contained WebAssembly architecture runs with zero cloud servers.",avatar:{...zt,browMood:-.45,genderStyle:"masculine",bgStyle:"emerald_mist",shoulderWidth:1.12,chestWidth:1.08,waistWidth:.92,posture:"confident",headWidth:1,cheekboneWidth:1.08,jawWidth:1.04,chinLength:.12,skinColor:"#eab69b",blushIntensity:.08,eyeSize:.95,irisColor:"#3b6998",lashStyle:"subtle",browThickness:1.28,lipFullness:.88,lipColor:"#b46c72",hairStyle:"side_sweep",hairColor:"#3b302a",hairHighlight:"#69584f",facialHair:"beard",outfitStyle:"turtleneck",outfitPrimary:"#1e222b",outfitSecondary:"#334155",outfitAccent:"#10b981",glasses:"classic",glassesColor:"#18181b",headsetMic:!1}},{id:"nova",persona:"witty",name:"Nova-7",role:"Cybernetic Companion",tagline:"Synth-porcelain android chassis, holo visor & crisp vocal tract",voicePreset:"female",voiceOverrides:{gender:"female",pitchHz:202,tractLengthCm:14.1,crispness:1.28,expressiveness:.92},greeting:"Systems online! [tilt] I am Nova Seven, running 100 percent locally inside your browser via WebAssembly.",avatar:{...zt,bgStyle:"studio_dark",shoulderWidth:1.02,shoulderSlope:-.1,chestWidth:.98,waistWidth:.74,posture:"presenter",skinColor:"#dce5f2",blushIntensity:.12,synthFinish:.85,earStyle:"cyber",eyeSize:1.08,eyeTilt:.12,irisColor:"#06b6d4",lashStyle:"classic",lipColor:"#7e8ce0",hairStyle:"pixie",hairColor:"#1e293b",hairHighlight:"#38bdf8",outfitStyle:"cyber",outfitPrimary:"#0f172a",outfitSecondary:"#1e293b",outfitAccent:"#22d3ee",glasses:"visor",glassesColor:"#06b6d4",headsetMic:!1}},{id:"arthur",persona:"curious",name:"Prof. Arthur",role:"Knowledge Curator",tagline:"Distinguished scholar with classic mustache & warm timbre",voicePreset:"deep",voiceOverrides:{gender:"male",pitchHz:90,speed:.95,warmth:.82,expressiveness:1.05},greeting:"[warmth=0.85] Good day! [bow] I am Professor Arthur. Feel free to inquire about any topic in my AIML knowledge base.",avatar:{...zt,restSmile:.2,browMood:.25,genderStyle:"masculine",bgStyle:"sunset",shoulderWidth:1.08,chestWidth:1.1,waistWidth:1.06,posture:"relaxed",headWidth:1.04,jawWidth:1.05,chinLength:.06,skinColor:"#dfa482",blushIntensity:.14,eyeSize:.94,irisColor:"#5c6f84",lashStyle:"subtle",browThickness:1.38,lipFullness:.85,lipColor:"#a8686c",hairStyle:"buzz",hairColor:"#94a3b8",hairHighlight:"#e2e8f0",facialHair:"mustache",outfitStyle:"vest",outfitPrimary:"#5b3e31",outfitSecondary:"#f8f4ec",outfitAccent:"#d97706",glasses:"round",glassesColor:"#78552b",headsetMic:!1}}];function le(e,t,a){return Math.max(t,Math.min(a,e))}function Je(e,t=[230,180,155]){let a=String(e||"").trim().replace(/^#/,"");if(a.length===3){let s=parseInt(a[0]+a[0],16),n=parseInt(a[1]+a[1],16),r=parseInt(a[2]+a[2],16);return Number.isFinite(s+n+r)?[s,n,r]:t}if(a.length>=6){let s=parseInt(a.slice(0,2),16),n=parseInt(a.slice(2,4),16),r=parseInt(a.slice(4,6),16);return Number.isFinite(s+n+r)?[s,n,r]:t}return t}function R([e,t,a],s=1){let n=le(Math.round(e),0,255),r=le(Math.round(t),0,255),i=le(Math.round(a),0,255);return s>=.999?`rgb(${n}, ${r}, ${i})`:`rgba(${n}, ${r}, ${i}, ${s.toFixed(3)})`}function se([e,t,a],s,n=0){return[e*s+n*14,t*s-Math.abs(n)*4,a*s-n*10]}function Fe(e,t,a){return[e[0]+(t[0]-e[0])*a,e[1]+(t[1]-e[1])*a,e[2]+(t[2]-e[2])*a]}function ys(){return{jaw:.045,tH:.46,tF:.5,tTip:.16,lipR:.04,lipS:.08,lipC:.2,velum:0,energy:0,voicing:0,noise:0,f0:160,f1:500,f2:1500,f3:2500,pitchSt:0,phone:"",ipa:"",word:"",glotPhase:0,wavePhase:0,lastTickMs:0,blinkStartMs:-1e3,nextBlinkMs:1600,saccadeX:0,saccadeY:0,nextSaccadeMs:1100,lookX:0,lookY:0,emote:"",emoteUntilMs:0,bodyMotion:null,mood:"",idleLife:!0,nextIdleMs:0,x:Object.fromEntries(As.map(e=>[e,0]))}}var As=["smile","frown","browUp","browIn","eyeWide","mouthO","wink","nod","shake","tilt","bow","bounce","shrug","think","laugh","gazeX","gazeY","shut","thumbUp"],mi=new Set(["browIn","eyeWide","tilt","gazeX","gazeY"]),bo={smile:{smile:.85,browUp:.3,eyeWide:-.12},wave:{smile:.75,browUp:.3},walk:{smile:.3},dance:{smile:.8,browUp:.25},stretch:{eyeWide:-.12},squat:{browIn:-.15},wink:{smile:.7,wink:1,tilt:.3},nod:{nod:1,smile:.3},shake:{shake:1,browIn:.25},laugh:{smile:1,eyeWide:-.6,browUp:.35,bounce:1,laugh:1},think:{think:1,browIn:-.3,tilt:-.7,gazeX:-.55,gazeY:-.55},surprised:{browUp:1,eyeWide:.9,mouthO:.75},shrug:{shrug:1,browUp:.7,tilt:.45,frown:.2},tilt:{tilt:1,smile:.3},bow:{bow:1,smile:.3},thumbsup:{smile:.8,browUp:.35,thumbUp:1},lookleft:{gazeX:-.95},lookright:{gazeX:.95},lookup:{gazeY:-.85,browUp:.3},lookdown:{gazeY:.85},chuckle:{smile:.8,eyeWide:-.35,browUp:.2,bounce:.45,laugh:.5},giggle:{smile:.9,eyeWide:-.5,tilt:.35,bounce:.7,laugh:.6},guffaw:{smile:1,shut:.7,browUp:.5,bounce:1,laugh:1},nervous:{smile:.4,browIn:.7,gazeX:.5,bounce:.3,laugh:.4},evil:{smile:.75,browIn:-.95,eyeWide:-.3,bounce:.45,laugh:.7,tilt:-.3},sigh:{browIn:.5,eyeWide:-.35,bow:.3,frown:.2},yawn:{shut:.85,browUp:.55,tilt:.3,mouthO:.9},sniff:{browIn:.6,frown:.3,eyeWide:-.2},pant:{bounce:.6,mouthO:.35,browIn:.3},phew:{browUp:.6,smile:.4,eyeWide:-.25},worried:{browIn:.85,eyeWide:.6,mouthO:.35},puzzled:{browUp:.7,tilt:.55,browIn:.3},aha:{browUp:.8,smile:.7,eyeWide:.3},ooh:{browUp:.7,mouthO:.6,eyeWide:.4},aww:{smile:.7,browIn:.6,tilt:.5,eyeWide:-.2},relief:{smile:.5,eyeWide:-.45,browUp:.2},disgust:{browIn:-.6,frown:.75,eyeWide:-.45,tilt:-.3},hum:{smile:.4,eyeWide:-.35,tilt:.35},groan:{frown:.6,browIn:.5,eyeWide:-.55,tilt:-.3},scream:{browUp:1,eyeWide:1,mouthO:1},cry:{browIn:.95,frown:.9,shut:.55,bow:.25},shush:{browUp:.35,eyeWide:.25,mouthO:.5},psst:{gazeX:-.6,tilt:-.35,browUp:.35},tsk:{shake:.55,browIn:-.45},kiss:{mouthO:.85,shut:.6,smile:.2},shiver:{bounce:.85,browIn:.5,shrug:.7},angry:{browIn:-1,frown:.5,eyeWide:-.3},raspberry:{shut:.5,mouthO:.4,tilt:.3},whistle:{mouthO:.7,browUp:.45},cough:{bow:.35,shut:.6,bounce:.3},hiccup:{bounce:.9,browUp:.6,eyeWide:.45},sneeze:{shut:1,bow:.55,browIn:.4},sleep:{shut:1,tilt:.5,bow:.2},idle_tilt_left:{tilt:-.42},idle_tilt_right:{tilt:.42,smile:.2},idle_smile:{smile:.5,browUp:.15},idle_brows:{browUp:.55},idle_glance_left:{gazeX:-.6,gazeY:-.1},idle_glance_right:{gazeX:.6,gazeY:-.1},happy:{smile:.7,browUp:.22},excited:{smile:.9,browUp:.65,eyeWide:.3},calm:{smile:.22,eyeWide:-.1},sad:{browIn:.9,frown:.85,eyeWide:-.2,bow:.15,gazeY:.3},serious:{browIn:-.75,eyeWide:-.12}},fi={happy:"smile",grin:"smile",yes:"nod",no:"shake",cackle:"laugh",hoho:"laugh",snicker:"chuckle",hehe:"giggle",gasp:"surprised",hmm:"think",um:"think",uh:"think",mm:"relief",ahh:"relief",mhm:"nod","uh-huh":"nod","uh-uh":"shake","uh-oh":"worried",huh:"puzzled",oh:"ooh",ugh:"disgust",eww:"disgust",sob:"cry",whimper:"cry",shh:"shush",brr:"shiver",grr:"angry",fweet:"whistle",ahem:"cough",snore:"sleep"},Ts={smile:1900,wink:750,nod:1e3,shake:1150,laugh:1700,think:2e3,surprised:1500,shrug:1500,tilt:1500,bow:1300,thumbsup:1900,lookleft:1300,lookright:1300,lookup:1300,lookdown:1300,sad:2400,serious:2e3,excited:1800,calm:1800},us=[["idle_tilt_left",1500],["idle_tilt_right",1500],["idle_smile",1700],["idle_brows",800],["idle_glance_left",1100],["idle_glance_right",1100]];function ba(e,t,a,s=performance.now()){if(!e||!t)return;let n=String(t).toLowerCase(),r=fi[n]||n;if(r==="rest"){e.bodyMotion=null,e.emote="",e.emoteUntilMs=s,e.nextIdleMs=0;return}if(r==="blink"){e.blinkStartMs=s;return}if(!Object.prototype.hasOwnProperty.call(bo,r))return;e.emote=r;let i=a>0?a:rn(r)||Ts[r]||1800;e.emoteUntilMs=s+i,cs(e,r,s,i)}function Ha(e,t){if(!e)return;let a=String(t||"").toLowerCase();e.mood=Object.prototype.hasOwnProperty.call(bo,a)?a:""}function Is(e,t,a=0){let s=e?.words||[],n=s.length,r=e?.duration||0,i=(t||[]).map(l=>{let p=l.word||0;a>0&&n>0&&a!==n&&(p=Math.round(p/a*n));let h=0;n>0&&p>0&&(h=p>=n?Math.max(0,r-.3):Math.max(0,s[p].start-.08));let c=l.sound&&p<n?s[p]:null;return c&&String(c.word).startsWith("[")?{...l,t:Math.max(0,c.start-.04),ms:Math.max(350,(c.end-c.start)*1e3+120)}:{...l,t:h}});return i.sort((l,p)=>l.t-p.t),{items:i,next:0}}function Ss(e,t=.34){let a=(e||[]).slice().sort((l,p)=>(l.word||0)-(p.word||0)),s=new Map,n=-1,r=0;return{items:a.map(l=>{let p=l.word||0;(p!==n||l.name==="rest")&&s.clear(),n=p;let h=p*t+(l.pauseMs||0)/1e3+r;if(l.type==="action"&&l.name!=="rest"){let c=rn(l.name),o=c?"body":l.name==="blink"?"eyes":"expression",d=s.get(o)||0;d>h&&(r+=d-h,h=d);let u=l.ms||c||Ts[l.name]||(l.name==="blink"?145:1800);s.set(o,h+u/1e3)}return{...l,t:h}}),next:0}}function Ho(e,t,a,s=performance.now()){if(t)for(;t.next<t.items.length&&t.items[t.next].t<=a;){let n=t.items[t.next++];n.type==="mood"?Ha(e,n.name):ba(e,n.name,n.ms,s)}}function bs(e,t,a=150){if(!e||!e.visemes||!e.visemes.length)return null;let s=e.visemeFields&&e.visemeFields.length||9,n=e.visemeRate||200,r=Math.floor(e.visemes.length/s);if(r<=0)return null;let i=le(t*n,0,r-1),l=Math.floor(i),p=Math.min(r-1,l+1),h=i-l,c=e.visemes,o=l*s,d=p*s,u=(g,f)=>g+(f-g)*h,m={jaw:u(c[o],c[d]),tH:u(c[o+1],c[d+1]),tF:u(c[o+2],c[d+2]),tTip:u(c[o+3],c[d+3]),lipR:u(c[o+4],c[d+4]),lipS:u(c[o+5],c[d+5]),lipC:u(c[o+6],c[d+6]),velum:u(c[o+7],c[d+7]),energy:u(c[o+8],c[d+8]),f0:a,f1:500,f2:1500,f3:2500,voicing:0,noise:0,phone:"",ipa:"",word:""};if(e.acoustics&&e.acoustics.length>=6){let g=e.acousticFields&&e.acousticFields.length||6,f=e.acoustics,E=l*g,y=p*g;y+5<f.length&&(m.f0=u(f[E],f[y]),m.f1=u(f[E+1],f[y+1]),m.f2=u(f[E+2],f[y+2]),m.f3=u(f[E+3],f[y+3]),m.voicing=u(f[E+4],f[y+4]),m.noise=u(f[E+5],f[y+5]))}else m.voicing=m.energy;if(e.phones)for(let g=0;g<e.phones.length;g++){let f=e.phones[g];if(t>=f.start&&t<f.end){m.phone=f.phone,m.ipa=f.ipa;break}}if(e.words)for(let g=0;g<e.words.length;g++){let f=e.words[g];if(t>=f.start&&t<f.end){m.word=f.word;break}}if(e.segments&&e.segments.length){let g=e.segments[0];for(let f=0;f<e.segments.length;f++){let E=e.segments[f];if(t>=E.start&&t<=E.end){g=E;break}t>=E.start&&(g=E)}m.segPitch=g.pitchHz}return m}function Hs(e,t,a,s=null,n=160){let r=e.lastTickMs>0?Math.min(.05,(t-e.lastTickMs)/1e3):.016;if(e.lastTickMs=t,e.emote&&t>e.emoteUntilMs&&(e.emote=""),e.idleLife!==!1){if(a||e.emote&&!e.emote.startsWith("idle_")||!e.nextIdleMs)e.nextIdleMs=t+5e3+Math.random()*7e3;else if(!e.emote&&t>=e.nextIdleMs){let[C,q]=us[Math.floor(Math.random()*us.length)];e.emote=C,e.emoteUntilMs=t+q,e.nextIdleMs=t+q+6e3+Math.random()*9e3}}else e.nextIdleMs=0,e.emote.startsWith("idle_")&&(e.emote="");let i=e.emote?bo[e.emote]:null,l=e.mood?bo[e.mood]:null,p=e.x,h=1-Math.exp(-r*13);for(let C of As){let q=0;i&&i[C]!==void 0?q=i[C]:l&&l[C]!==void 0&&(q=l[C]*.7),p[C]+=(q-p[C])*h,!mi.has(C)&&p[C]<5e-4&&(p[C]=0)}let c=.5+.5*Math.sin(t*.0019),o=.09+p.smile*.3,d=p.laugh*(.2+.14*Math.abs(Math.sin(t*.019))),u=a||{jaw:.038+.012*c+p.mouthO*.3+d,tH:.46,tF:.5,tTip:.16,lipR:.03+p.mouthO*.5,lipS:o,lipC:.22*(1-Math.max(p.mouthO,p.laugh)),velum:0,energy:0,voicing:0,noise:0,f0:n,f1:500,f2:1500,f3:2500,phone:"",ipa:"",word:""},m=1-Math.exp(-r*(a?38:10)),g=1-Math.exp(-r*(a?22:7.5));e.jaw+=(u.jaw-e.jaw)*m,e.tH+=(u.tH-e.tH)*m,e.tF+=(u.tF-e.tF)*m,e.tTip+=(u.tTip-e.tTip)*m,e.lipR+=(u.lipR-e.lipR)*m,e.lipS+=(Math.max(u.lipS,p.smile*.3)-e.lipS)*m,e.lipC+=(u.lipC-e.lipC)*m,e.velum+=(u.velum-e.velum)*g,e.energy+=(u.energy-e.energy)*m,e.voicing+=(u.voicing-e.voicing)*m,e.noise+=(u.noise-e.noise)*m,e.f0+=(u.f0-e.f0)*g,e.f1+=(u.f1-e.f1)*g,e.f2+=(u.f2-e.f2)*g,e.f3+=(u.f3-e.f3)*g,e.phone=u.phone||"",e.ipa=u.ipa||"",e.word=u.word||"";let f=a?.segPitch||n||150,E=e.voicing>.12?12*Math.log2(Math.max(50,e.f0)/Math.max(50,f)):0;e.pitchSt+=(le(E,-6,9)-e.pitchSt)*g,e.glotPhase=(e.glotPhase+r*(6+e.f0*.055))%1,e.wavePhase=(e.wavePhase+r*(1.7+e.energy*1.4))%1,t>=e.nextBlinkMs&&(e.blinkStartMs=t,e.nextBlinkMs=t+2500+Math.random()*3100),t>=e.nextSaccadeMs&&(e.saccadeX=(Math.random()-.5)*.24,e.saccadeY=(Math.random()-.5)*.16,e.nextSaccadeMs=t+1200+Math.random()*2200);let y=e.saccadeX,w=e.saccadeY;s&&s.active&&(y=le(s.nx,-1,1)*.92+e.saccadeX*.22,w=le(s.ny,-1,1)*.85+e.saccadeY*.22);let k=Math.min(1,Math.abs(p.gazeX)+Math.abs(p.gazeY));k>.02&&(y+=(p.gazeX-y)*k,w+=(p.gazeY-w)*k);let Y=1-Math.exp(-r*8.5);e.lookX+=(y-e.lookX)*Y,e.lookY+=(w-e.lookY)*Y}function ws(e,t,a){let s=a.framing||"half",n=240,r=240,i=18;if(s==="bust")n=205,r=210,i=6;else if(s==="half"){n=265,r=290;let o=(a.headHeight??1)*(a.headScale??1),d=["quiff","updo_bun","space_buns","mohawk","afro","curly_halo"].includes(a.hairStyle);i=a.headwear&&a.headwear!=="none"||d?46:46+le(17-(o-1)*90,0,22)}else n=290,r=340,i=68;let l=le(Number(a.bodyScale)||1,.78,1.24),p=Math.min(e/n,t/r)*l,h=e*.5,c=t*.5-i*p+(s==="bust"?10*p:8*p);return{cx:h,cy:c,scale:p,framing:s}}function Ns(e){let t=e.genderStyle==="feminine",a=e.genderStyle==="masculine",s=le(Number(e.headScale)||1,.82,1.25),n=(t?50.5:a?54:52.2)*le(e.headWidth??1,.76,1.28)*s,r=66*le(e.headHeight??1,.82,1.22)*s,i=n*le(e.cheekboneWidth??1,.82,1.24),l=(t?36.5:a?43.5:40)*le(e.jawWidth??1,.7,1.32)*s,p=(55+(e.chinLength??0)*22)*s,h=(t?16.8:a?21.5:19)*le(e.neckWidth??1,.68,1.38),c=34*le(e.neckLength??1,.72,1.4),o=44+c,d=(t?68:a?82:75)*le(e.shoulderWidth??1,.68,1.45),u=13+le(e.shoulderSlope??.08,-.4,.5)*24,m=128*le(e.torsoLength??1,.78,1.32),g=(t?52:a?62:57)*le(e.chestWidth??1,.68,1.42),f=(t?41:a?53:47)*le(e.waistWidth??1,.55,1.42),E=(t?55:a?56:55)*le(e.hipWidth??1,.68,1.42),y=(t?14.5:a?18:16.2)*le(e.armThickness??1,.68,1.45);return{isFem:t,isMasc:a,headScale:s,headW:n,headH:r,cheekW:i,jawW:l,chinBaseY:p,neckHalfW:h,neckLen:c,shoulderY:o,shoulderHalfW:d,shoulderDrop:u,torsoLen:m,chestHalfW:g,waistHalfW:f,hipHalfW:E,armThick:y}}function gi(e,t,a){let{cx:s,cy:n,scale:r}=ws(e,t,a),i=Ns(a),l=(h,c)=>({x:s+h*r,y:n+c*r}),p=[{id:"crown",label:"Head Height",...l(0,-i.headH-6),axis:"y",apply(h,c,o){return{headHeight:le((o.headHeight??1)-c/r*.009,.82,1.22)}}},{id:"temple",label:"Head Width",...l(i.headW+4,-18*i.headScale),axis:"x",mirrorX:s-(i.headW+4)*r,apply(h,c,o){return{headWidth:le((o.headWidth??1)+h/r*.012,.78,1.25)}}},{id:"jaw",label:"Jaw Width",...l(i.jawW+3,34*i.headScale),axis:"x",mirrorX:s-(i.jawW+3)*r,apply(h,c,o){return{jawWidth:le((o.jawWidth??1)+h/r*.014,.72,1.28)}}},{id:"chin",label:"Chin Length & Shape",...l(0,i.chinBaseY+4),axis:"xy",apply(h,c,o){return{chinLength:le((o.chinLength??0)+c/r*.018,-.35,.45),chinRoundness:le((o.chinRoundness??.65)+h/r*.015,.05,1)}}},{id:"eyes",label:"Eye Spacing & Size",...l(22*(a.eyeSpacing??1)*i.headScale+10,-12*i.headScale),axis:"xy",apply(h,c,o){return{eyeSpacing:le((o.eyeSpacing??1)+h/r*.016,.8,1.24),eyeSize:le((o.eyeSize??1)-c/r*.018,.75,1.38)}}},{id:"mouth",label:"Mouth Width & Lips",...l(21*(a.mouthWidth??1)*i.headScale+4,31*i.headScale),axis:"xy",apply(h,c,o){return{mouthWidth:le((o.mouthWidth??1)+h/r*.018,.76,1.3),lipFullness:le((o.lipFullness??1)+c/r*.022,.65,1.5)}}},{id:"neck",label:"Neck Width & Length",...l(i.neckHalfW+3,44+i.neckLen*.48),axis:"xy",mirrorX:s-(i.neckHalfW+3)*r,apply(h,c,o){return{neckWidth:le((o.neckWidth??1)+h/r*.018,.7,1.35),neckLength:le((o.neckLength??1)+c/r*.015,.75,1.35)}}},{id:"shoulder",label:"Shoulders (Width & Slope)",...l(i.shoulderHalfW,i.shoulderY+i.shoulderDrop),axis:"xy",mirrorX:s-i.shoulderHalfW*r,apply(h,c,o){return{shoulderWidth:le((o.shoulderWidth??1)+h/r*.01,.7,1.42),shoulderSlope:le((o.shoulderSlope??.08)+c/r*.014,-.35,.45)}}}];return p.push({id:"brow",label:"Brow Arch & Thickness",...l(-(21.5*(a.eyeSpacing??1)*i.headScale+6),-(27+(a.browArch??.2)*9)*i.headScale),axis:"xy",apply(h,c,o){return{browArch:le((o.browArch??.2)-c/r*.03,-.2,.55),browThickness:le((o.browThickness??1)-h/r*.03,.5,1.6)}}},{id:"nose",label:"Nose Length & Width",...l(-9.5*(a.noseWidth??1)*i.headScale,10.2*(a.noseLength??1)*i.headScale),axis:"xy",apply(h,c,o){return{noseWidth:le((o.noseWidth??1)-h/r*.03,.74,1.32),noseLength:le((o.noseLength??1)+c/r*.03,.78,1.26)}}}),a.framing!=="bust"&&p.push({id:"hips",label:"Hip Width",...l(i.hipHalfW,i.shoulderY+i.torsoLen*1.06),axis:"x",mirrorX:s-i.hipHalfW*r,apply(h,c,o){return{hipWidth:le((o.hipWidth??1)+h/r*.013,.7,1.38)}}},{id:"chest",label:"Chest / Bust Width",...l(i.chestHalfW,i.shoulderY+i.torsoLen*.34),axis:"x",mirrorX:s-i.chestHalfW*r,apply(h,c,o){return{chestWidth:le((o.chestWidth??1)+h/r*.012,.7,1.38)}}},{id:"waist",label:"Waist Taper & Torso Length",...l(i.waistHalfW,i.shoulderY+i.torsoLen*.7),axis:"xy",mirrorX:s-i.waistHalfW*r,apply(h,c,o){return{waistWidth:le((o.waistWidth??1)+h/r*.013,.58,1.38),torsoLength:le((o.torsoLength??1)+c/r*.008,.8,1.28)}}},{id:"arm",label:"Arm Build",...l(i.shoulderHalfW+i.armThick*.78,i.shoulderY+i.shoulderDrop+i.torsoLen*.42),axis:"x",mirrorX:s-(i.shoulderHalfW+i.armThick*.78)*r,apply(h,c,o){return{armThickness:le((o.armThickness??1)+h/r*.022,.7,1.4)}}}),p.filter(h=>h.y>10&&h.y<t-10)}var ds=[[-4,1.5,.7],[5,2.5,.65],[-9,3.5,.75],[10,4,.7],[.5,4.5,.6],[-15,4.5,.8],[16,5.5,.75],[-20,6.5,.7],[21,7,.7],[-12,8,.65],[13,9,.7],[-25,9.5,.75],[26,10,.7],[-18,11,.6],[19,11.5,.65],[-6,6.5,.55],[7,7.5,.6],[-23,13,.6],[24,13.5,.6],[-29,8,.6],[30,8.5,.6],[-14,13.5,.55],[15,14,.55],[-2,0,.55],[2.5,8.5,.5],[-27,5,.55],[28,5.5,.55],[-10,11.5,.5],[11,12.5,.5],[-21,3,.55]];function un(e,t,a,s,n){let r=s.framing==="cutout"?"cutout":s.stageShape||"card",i=2;if(e.beginPath(),r==="circle"){let o=Math.min(t,a)*.5-i;e.arc(t*.5,a*.5,Math.max(10,o),0,Math.PI*2)}else if(r==="arch"){let o=t-i*2,d=a-i*2,u=o*.5;e.moveTo(i,i+u),e.arc(t*.5,i+u,u,Math.PI,0),e.lineTo(i+o,i+d-18),e.quadraticCurveTo(i+o,i+d,i+o-18,i+d),e.lineTo(i+18,i+d),e.quadraticCurveTo(i,i+d,i,i+d-18),e.closePath()}else r==="card"?e.roundRect(i,i,t-i*2,a-i*2,Math.min(26,t*.08)):e.rect(0,0,t,a);if(e.clip(),r==="cutout"||s.bgStyle==="transparent")return;let l="#162033",p="#0b101b",h="rgba(56, 189, 248, 0.22)";switch(s.bgStyle){case"warm_cream":l="#f6efe4",p="#e3d8c6",h="rgba(217, 119, 6, 0.16)";break;case"sky_glass":l="#dcebfa",p="#b8d2ef",h="rgba(37, 99, 235, 0.18)";break;case"emerald_mist":l="#132a28",p="#091515",h="rgba(45, 212, 191, 0.22)";break;case"sunset":l="#3a2234",p="#1b121c",h="rgba(251, 146, 60, 0.24)";break;case"violet_haze":l="#2a2146",p="#120e22",h="rgba(167, 139, 250, 0.26)";break;case"mint_fresh":l="#e2f4ec",p="#bfe3d3",h="rgba(16, 185, 129, 0.18)";break;case"graphite":l="#3a3f4a",p="#1c1f26",h="rgba(226, 232, 240, 0.16)";break;case"custom":{let o=Je(s.bgColor,[22,32,51]);l=R(se(o,1.18)),p=R(se(o,.68));let d=Je(s.bgAccent,[56,189,248]);h=R(d,.25);break}default:break}let c=e.createLinearGradient(0,0,0,a);if(c.addColorStop(0,l),c.addColorStop(1,p),e.fillStyle=c,e.fillRect(0,0,t,a),s.haloGlow!==!1){let o=1+n.voicing*.28+n.energy*.18,d=Math.min(t,a)*.46*o,u=e.createRadialGradient(t*.5,a*.42,d*.08,t*.5,a*.42,d);u.addColorStop(0,h),u.addColorStop(1,"rgba(0,0,0,0)"),e.fillStyle=u,e.fillRect(0,0,t,a)}}function ea(e,t,a,s,n,r,i,l,p){let h=a.x-t.x,c=a.y-t.y,o=Math.hypot(h,c);e.save(),e.translate(t.x,t.y),e.rotate(Math.atan2(-h,c));let d=c>=0?1:-1,u=e.createLinearGradient(-d*s,0,d*s,0);u.addColorStop(0,r),u.addColorStop(.42,i),u.addColorStop(1,l),e.fillStyle=u,e.beginPath(),e.moveTo(-s,0),e.bezierCurveTo(-s,-s*1.3,s,-s*1.3,s,0),e.bezierCurveTo(s*1.04,o*.33,n,o*.8,n,o),e.quadraticCurveTo(0,o+n*.95,-n,o),e.bezierCurveTo(-n,o*.82,-s*1.03,o*.37,-s,0),e.closePath(),e.fill(),p&&(e.fillStyle=p,e.beginPath(),e.moveTo(-n,o-4),e.quadraticCurveTo(0,o-1,n,o-4),e.lineTo(n,o),e.quadraticCurveTo(0,o+n*.65,-n,o),e.closePath(),e.fill()),e.restore()}function Ei(e,t,a,s,n,r,i,l,p){e.save(),e.translate(t.x,t.y),e.rotate(a),e.scale(n*s,s);let h=e.createLinearGradient(-7,0,9,14);if(h.addColorStop(0,i),h.addColorStop(.58,l),h.addColorStop(1,p),e.fillStyle=h,e.strokeStyle=h,e.lineCap="round",r==="wave"){for(let[c,o,d]of[[-5,-8,21],[-1.6,-2.4,25],[2.3,3.4,24],[5.4,8.4,19]])e.lineWidth=3.8,e.beginPath(),e.moveTo(c,11),e.quadraticCurveTo((c+o)/2,18,o,d),e.stroke();e.lineWidth=4.6,e.beginPath(),e.moveTo(4,6),e.quadraticCurveTo(9,7,12,14),e.stroke()}e.beginPath(),e.moveTo(-4.4,-2),e.bezierCurveTo(-5,2,-8.4,6,-7.2,12),r==="wave"?(e.quadraticCurveTo(-1,18.2,6.8,13),e.quadraticCurveTo(9,7,5,1)):r==="point"?(e.quadraticCurveTo(-7.4,15,-5.2,16),e.lineTo(-5.1,28),e.quadraticCurveTo(-3.6,31,-1.2,28.2),e.lineTo(.5,16.2),e.quadraticCurveTo(7.5,19,7.9,12),e.quadraticCurveTo(10,8.4,5,1)):r==="thumbsup"?(e.quadraticCurveTo(-8,17,-2,17),e.lineTo(2.5,17),e.quadraticCurveTo(4,20,4,24),e.bezierCurveTo(4,29,9,27,9.2,22),e.quadraticCurveTo(11,9,5,1)):r==="present"?(e.bezierCurveTo(-6,18,-1,23,3,25),e.quadraticCurveTo(6,26,4.6,22.5),e.quadraticCurveTo(2.2,18.2,1.4,14.5),e.quadraticCurveTo(4.2,18.2,6.5,18.4),e.quadraticCurveTo(9,17.4,6.5,14),e.quadraticCurveTo(4.4,11.4,4.1,9),e.quadraticCurveTo(12,13,10.3,9.4),e.quadraticCurveTo(6.1,5.4,4.7,1)):(e.bezierCurveTo(-7.4,18,-5.3,22,-2,21),e.quadraticCurveTo(2,22,4.5,16),e.quadraticCurveTo(7,11,6.8,9),e.quadraticCurveTo(10.5,14.7,11,10.8),e.quadraticCurveTo(9.6,5.2,4.8,1)),e.lineTo(4.2,-2),e.closePath(),e.fill(),e.strokeStyle=p,e.lineWidth=1,e.beginPath(),e.moveTo(4.7,7),e.quadraticCurveTo(1.5,8,1.1,12),e.stroke(),e.restore()}function Oi(e,t,a,s,n,r,i,l,p){let h=t.wardrobe||{},c=h.bottom||"trousers",o=/dress|gown|bodycon|satin|cocktail|sleeved/.test(t.outfitStyle),d=o||/skirt|tennis/.test(c),u=/shorts|briefs|^denim$/.test(c),m=o?p:Je(h.bottomColor,Fe(p,[36,28,48],.42)),g=h.legwear==="sheer"?Fe(l,Je(h.legwearColor,l),.53):l,f=h.shoes==="barefoot"?g:Je(h.shoeColor,[63,50,64]),E=Math.PI/180;d||(e.fillStyle=R(m),e.beginPath(),e.moveTo(-a.hipHalfW,s-7),e.quadraticCurveTo(-a.hipHalfW*.83,s+11,0,s+16),e.quadraticCurveTo(a.hipHalfW*.83,s+11,a.hipHalfW,s-7),e.fill());for(let y of i<0?[-1,1]:[1,-1]){let w=y>0?"left":"right",k=(r[w+"Hip"]||0)*E,Y=k-(r[w+"Knee"]||0)*E,C={x:y*a.hipHalfW*.48,y:s-13},q={x:C.x+n*Math.sin(k)*i,y:C.y+n*Math.cos(k)},Q={x:q.x+n*Math.sin(Y)*i,y:q.y+n*Math.cos(Y)},de=y*i>0,D=V=>[1.1,.97,.73].map(ee=>R(se(V,ee*(de?.84:1)))),M=a.hipHalfW,A=d||u?g:m;if(ea(e,C,q,M*.48,M*.32,...D(A)),ea(e,q,Q,M*.32,M*.22,...D(A)),u&&!d){let V={x:C.x+(q.x-C.x)*.55,y:C.y+(q.y-C.y)*.55};ea(e,C,V,M*.49,M*.4,...D(m))}let I={knee_boots:.84,heels:.43,ankle:.32,court_high_tops:.25}[h.shoes];if(I){let V={x:Q.x+(q.x-Q.x)*I,y:Q.y+(q.y-Q.y)*I};ea(e,V,Q,M*(.23+.09*I),M*.23,...D(f))}let H=Y+(r[w+"AnkleFlex"]||0)*E,W={x:Q.x+(i+y*.18)*M*.49,y:Q.y+6-M*.38*Math.sin(H)};ea(e,Q,W,M*.23,M*.175,...D(f))}if(d){let y=a.hipHalfW,w=s+n*(c==="midi_skirt"||/gown/.test(t.outfitStyle)?1.36:.68),k=((r.leftHip||0)-(r.rightHip||0))*i*.14,Y=e.createLinearGradient(-y,0,y,0);Y.addColorStop(0,R(se(m,.78))),Y.addColorStop(.48,R(m)),Y.addColorStop(1,R(se(m,.69))),e.fillStyle=Y,e.beginPath(),e.moveTo(-y,s-6),e.lineTo(y,s-6),e.lineTo(y*1.13+k,w),e.quadraticCurveTo(k,w+6,-y*1.13+k,w),e.closePath(),e.fill()}}function wo(e,t,a,s,n,r=performance.now(),i={}){let l={...zt,...s||{}};l.headwear==="headscarf"&&(l.hairStyle="none"),e.clearRect(0,0,t,a),e.save(),un(e,t,a,l,n);let{cx:p,cy:h,scale:c}=ws(t,a,l),o=Ns(l),d=r*.001,u=ln(n,r,i.reducedMotion),m=!!(n.guideTravel||n.tourPointing),g=m?Math.sin((u?.rootYaw||0)*Math.PI/180):0,f=96*le(l.legLength??1,.73,1.35),E=cn(n,u),y=Je(l.skinColor,[241,198,176]),w=le(l.synthFinish??0,0,1),k=Fe(y,[218,228,242],w*.55),Y=Fe(se(k,1.12,.25),[248,252,255],w*.45),C=Fe(se(k,.8,.35),[118,136,166],w*.55),q=Fe(se(k,.64,.45),[72,88,118],w*.55),Q=Je(l.hairColor,[60,39,52]),de=Je(l.hairHighlight,se(Q,1.45)),D=Je(l.outfitPrimary,[30,47,77]),M=Je(l.outfitSecondary,[244,246,251]),A=Je(l.outfitAccent,[56,189,248]),I=Math.sin(d*1.9)*1.15,H=n.x||{},W=T=>H[T]||0,V=W("nod")*Math.sin(d*11)*3.8+W("bow")*7.5-W("bounce")*Math.abs(Math.sin(d*15))*2.4,ee=n.energy*2.5-n.pitchSt*.52+Math.sin(d*1.4)*.75+V,v=Math.sin(d*.82)*.015+n.pitchSt*.006*Math.cos(d*1.8)+n.lookX*.032+W("tilt")*.095,P=le(l.restSmile??0,-.4,1),X=le(W("smile")+P*.75,-.4,1.2),oe=le(W("browIn")-le(l.browMood??0,-1,1)*.55,-1.2,1.2),$=le(W("eyeWide")+le(l.eyeOpen??0,-.5,.5),-.8,1),ae=n.lookX*5.2+W("shake")*Math.sin(d*13)*7+g*19,ue=l.headwear||"none",Ae=ue==="beanie"||ue==="cap"||ue==="beret"||ue==="fedora"||ue==="chef",we=-o.headH*.56-5,ye=()=>{Ae&&(e.beginPath(),e.rect(-400,we,800,1200),e.clip())},Oe=n.lookY*3,ce=n.jaw*14.2*(1-n.lipC*.55)*o.headScale,ve=o.chinBaseY+ce,Re=o.shoulderHalfW+o.torsoLen*.74+30,ie=n.guideDirection?Math.min(c,t/(2*Re)):c,x=p,fe=h;if(m){let T=n.guideTravel?.point??1,O=-o.headH*1.32-26,S=o.shoulderY+o.torsoLen*1.12+2*f+9,b=Math.min(t/290,a*.97/(S-O)),N=Math.min(t/(1.7*Re),a/290),G=a*.98-S*b,z=a*.07-O*N;ie=b+(N-b)*T,fe=G+(z-G)*T,x-=hn(n.guideDirection)*.15*Re*N*T}if(e.translate(x,fe),e.scale(ie*(1-.22*Math.abs(g)),ie),u&&!i.showSculptHandles&&(e.translate((u.rootX||0)*21+(u.rootSway||0)*44,(u.leftKnee||0)*.17),e.rotate((u.torsoLean||0)*Math.PI/420)),ue==="headscarf"){let T=Je(l.headwearColor,[180,69,47]);e.save(),e.translate(-ae*.42,ee*.65),e.rotate(v*.55);let O=e.createLinearGradient(0,-o.headH,0,o.shoulderY+30);O.addColorStop(0,R(se(T,.95))),O.addColorStop(1,R(se(T,.62))),e.fillStyle=O,e.beginPath(),e.moveTo(-o.headW-9,-14),e.bezierCurveTo(-o.headW-15,-o.headH*1.36-16,o.headW+15,-o.headH*1.36-16,o.headW+9,-14),e.bezierCurveTo(o.headW+16,30,o.shoulderHalfW*.74,o.shoulderY+2,o.shoulderHalfW*.82,o.shoulderY+22),e.lineTo(-o.shoulderHalfW*.82,o.shoulderY+22),e.bezierCurveTo(-o.shoulderHalfW*.74,o.shoulderY+2,-o.headW-16,30,-o.headW-9,-14),e.closePath(),e.fill(),e.restore()}let ge=l.hairStyle==="curly_halo"||l.hairStyle==="afro";if(l.hairStyle==="ponytail"){e.save(),e.translate(-ae*.42,ee*.65),e.rotate(v*.55),ye();let T=Math.sin(d*1.6)*1.6+W("shake")*Math.sin(d*13-.6)*5,O=-o.headH*.58,S=o.shoulderY+34,b=e.createLinearGradient(0,O,0,S);b.addColorStop(0,R(se(Q,.95))),b.addColorStop(1,R(se(Q,.55))),e.fillStyle=b,e.beginPath(),e.moveTo(o.headW*.35,O),e.bezierCurveTo(o.headW+26,O-4,o.headW+30+T,18,o.headW+20+T,S-20),e.quadraticCurveTo(o.headW+14+T,S+4,o.headW+6+T,S),e.bezierCurveTo(o.headW+12+T*.6,26,o.headW+6,-6,o.headW*.2,O+14),e.closePath(),e.fill(),e.restore()}if(l.hairStyle==="pigtails"){e.save(),e.translate(-ae*.42,ee*.65),e.rotate(v*.55),ye();let T=Math.sin(d*1.6)*1.4+W("shake")*Math.sin(d*13-.6)*4,O=4,S=o.shoulderY+30;for(let b of[-1,1]){let N=b*(o.headW-3),G=e.createLinearGradient(0,O-10,0,S);G.addColorStop(0,R(se(Q,1.02))),G.addColorStop(1,R(se(Q,.58))),e.fillStyle=G,e.beginPath(),e.moveTo(N,O-12),e.bezierCurveTo(N+b*34,O-12,N+b*40+T,S-36,N+b*24+T,S-6),e.quadraticCurveTo(N+b*15+T,S+7,N+b*6+T,S-8),e.bezierCurveTo(N+b*12,S-40,N+b*5,O+24,N-b*3,O+10),e.closePath(),e.fill(),e.fillStyle=R(A),e.beginPath(),e.ellipse(N+b*12.5,O+3,4.4,7,b*.45,0,Math.PI*2),e.fill()}e.restore()}if(l.hairStyle==="long_waves"||l.hairStyle==="shoulder_lob"||l.hairStyle==="sleek_bob"||l.hairStyle==="long_straight"||l.hairStyle==="braids"||ge){e.save(),e.translate(-ae*.42,ee*.65),e.rotate(v*.55),ye();let T=l.hairStyle==="braids"?36:l.hairStyle==="long_straight"?o.shoulderY+66:l.hairStyle==="long_waves"?o.shoulderY+46:l.hairStyle==="shoulder_lob"?o.shoulderY+18:ge?42:48,O=l.hairStyle==="afro"?38:l.hairStyle==="curly_halo"?24:l.hairStyle==="long_waves"?17:l.hairStyle==="long_straight"?7:11,S=e.createLinearGradient(0,-o.headH-16,0,T);if(S.addColorStop(0,R(se(Q,1.05))),S.addColorStop(.6,R(se(Q,.75))),S.addColorStop(1,R(se(Q,.48))),e.fillStyle=S,e.beginPath(),ge){let b=l.hairStyle==="afro",N=o.headW+O,G=o.headH*.92+(b?30:16),z=b?-22:-14,pe=b?24:18;e.moveTo(N,z);for(let Ce=0;Ce<pe;Ce++){let xe=(Ce+1)*2*Math.PI/pe,tt=(Ce+.5)*2*Math.PI/pe,Et=5+2*Math.sin(Ce*2.4);e.quadraticCurveTo((N+Et)*Math.cos(tt),z+(G+Et)*Math.sin(tt),N*Math.cos(xe),z+G*Math.sin(xe))}e.closePath()}else e.moveTo(-o.headW-9,-12),e.bezierCurveTo(-o.headW-15,-o.headH-20,o.headW+15,-o.headH-20,o.headW+9,-12),l.hairStyle==="long_waves"?(e.bezierCurveTo(o.headW+24,24,o.headW+1,39,o.headW+12,65),e.bezierCurveTo(o.headW+26,94,o.headW+4,T-9,o.headW+10,T),e.quadraticCurveTo(o.headW-6,T-2,o.headW-6,T-21)):e.bezierCurveTo(o.headW+O+4,34,o.headW+O,T-9,o.headW-1,T),e.quadraticCurveTo(1,T+10,-o.headW+1,T-2),e.bezierCurveTo(-o.headW-O,T-16,-o.headW-O-4,34,-o.headW-9,-12),e.closePath();if(e.fill(),!ge){e.clip(),e.fillStyle=R(Fe(Q,de,.37),.66);for(let b of[-1,1])e.beginPath(),e.moveTo(b*(o.headW-9),-o.headH+6),e.bezierCurveTo(b*(o.headW+35),4,b*(o.headW-3),T*.5,b*(o.headW+9),T-3),e.bezierCurveTo(b*(o.headW-13),T*.56,b*(o.headW+25),2,b*(o.headW-9),-o.headH+6),e.fill()}e.restore()}let U=o.shoulderY+I*.65,te=U+o.shoulderDrop-W("shrug")*10,K=U+o.torsoLen*.68,ne=U+o.torsoLen*1.12;m&&Oi(e,l,o,ne,f,u||{},g,k,D);let he=e.createLinearGradient(-o.neckHalfW-8,42,o.neckHalfW+8,U+16);if(he.addColorStop(0,R(C)),he.addColorStop(.36,R(Y)),he.addColorStop(.72,R(k)),he.addColorStop(1,R(q)),e.fillStyle=he,e.beginPath(),e.moveTo(-o.neckHalfW,34),e.quadraticCurveTo(-o.neckHalfW-1,U-6,-o.neckHalfW-24,U+18),e.lineTo(o.neckHalfW+24,U+18),e.quadraticCurveTo(o.neckHalfW+1,U-6,o.neckHalfW,34),e.closePath(),e.fill(),w>.35){e.strokeStyle=R(A,.42*w),e.lineWidth=1.2;for(let T of[49,59])e.beginPath(),e.moveTo(-o.neckHalfW*.92,T),e.quadraticCurveTo(0,T+3.5,o.neckHalfW*.92,T),e.stroke()}let Z=e.createRadialGradient(ae*.5,51+ee,4,ae*.3,56+ee,o.neckHalfW*1.48);Z.addColorStop(0,"rgba(38, 18, 16, 0.44)"),Z.addColorStop(1,"rgba(38, 18, 16, 0)"),e.fillStyle=Z,e.beginPath(),e.ellipse(ae*.35,55+ee,o.neckHalfW*1.28,15+ce*.25,0,0,Math.PI*2),e.fill();let j=l.outfitStyle||"blazer",me=["tee","polo","scoop","apron","rugby_shirt"].includes(j),Ee=j==="vest"?M:D,ke=[R(se(Ee,1.13)),R(Ee),R(se(Ee,.72))],He=[R(Y),R(k),R(C)],Pe=R(Fe(Ee,A,.32)),Ye=n.energy*5.5+Math.max(0,n.pitchSt)*.7,Ge=u&&n.bodyMotion&&!n.guideTravel&&r<n.bodyMotion.end,Le=Ge&&n.bodyMotion.id==="wave",Ze=m&&E?.side===1?-1:1,je=[];for(let T of[-1,1]){let O=o.armThick,S={x:T*(o.shoulderHalfW-O*.4),y:te+O*.68},b={x:T*(o.shoulderHalfW+O*.5),y:U+o.torsoLen*.59},N={x:T*(o.hipHalfW+O*.75),y:ne-18},G="relaxed",z=0;if(l.posture==="presenter"&&T===1?(N.x=o.chestHalfW*.68,N.y=K-17-Ye,z=.12,G="present"):l.posture==="confident"?(b.x=T*(o.waistHalfW+O*.42),b.y=U+o.torsoLen*.56,N.x=-T*o.chestHalfW*.27,N.y=U+o.torsoLen*.43+O*(T<0?-.6:.34)):l.posture==="welcoming"&&(N.x=T*(o.chestHalfW+O*1.52),N.y-=3+Ye*.6),T===Ze&&!n.guideTravel&&(Le||n.emote==="thumbsup")){let pe=Le?le((u.rightArmLift||0)/74,0,1):W("thumbUp"),Ce=Le&&u.rightWristBend||0;b.x+=(S.x+T*o.torsoLen*.21-b.x)*pe,b.y+=(S.y+o.torsoLen*.19-b.y)*pe,N.x+=(S.x+T*(o.torsoLen*.19+Ce*.35)-N.x)*pe,N.y+=(S.y-o.torsoLen*.26-N.y)*pe,z=Ce*Math.PI/180,G=Le?"wave":"thumbsup"}else if((Ge||n.guideTravel)&&!Le){G="relaxed";let pe=T===1?"right":"left",Ce=Math.PI/180,xe=(u[pe+"ArmLift"]||0)*Ce,tt=(u[pe+"Shoulder"]||0)*Ce,Et=(u[pe+"Elbow"]||0)*Ce,Nt=o.torsoLen*.43;if(b.x=S.x+T*Nt*Math.sin(xe+.13),b.y=S.y+Nt*Math.cos(xe)*Math.cos(tt),N.x=b.x+T*Nt*.87*Math.sin(xe+Et*.36),N.y=b.y+Nt*.87*Math.cos(xe+Et*.36)*Math.cos(tt+Et),n.guideTravel){let xa=g*Nt*Math.sin(tt);b.x+=xa,N.x+=xa+g*Nt*.87*Math.sin(tt+Et)}z=(u[pe+"WristBend"]||0)*Ce}if(E?.side===T){let pe=o.torsoLen*.72,Ce=E.elevation,xe=S.x+T*pe*.48*Math.cos(Ce-.25),tt=S.y-pe*.48*Math.sin(Ce-.25);b.x+=(xe-b.x)*E.weight,b.y+=(tt-b.y)*E.weight,N.x+=(xe+T*pe*.52*Math.cos(Ce+.2)-N.x)*E.weight,N.y+=(tt-pe*.52*Math.sin(Ce+.2)-N.y)*E.weight,z=0,G=m?"point":"present"}if(me){let pe={x:S.x*.56+b.x*.44,y:S.y*.56+b.y*.44};ea(e,pe,b,O*.66,O*.56,...He),ea(e,S,pe,O*.9,O*.8,...ke,j==="rugby_shirt"?R(A):Pe)}else ea(e,S,b,O*.88,O*.71,...ke),j==="track_jacket"&&(e.strokeStyle=R(A),e.lineWidth=O*.19,e.beginPath(),e.moveTo(S.x+T*O*.46,S.y),e.lineTo(b.x+T*O*.39,b.y),e.stroke());je.push({elbow:b,wrist:N,dir:T,wristBend:z,gesture:G})}let Ne=e.createLinearGradient(-o.shoulderHalfW,U,o.shoulderHalfW,ne);Ne.addColorStop(0,R(se(D,1.16))),Ne.addColorStop(.48,R(D)),Ne.addColorStop(1,R(se(D,.66)));let We=["blazer","suit_tie","vest","cardigan","jacket"].includes(j),Xe=o.shoulderHalfW*(j==="vest"?.83:.98),J=T=>U+(K-U)*T/1.57,dt=J(We?2.1:j==="field_overshirt"?1.96:1.57);if(e.fillStyle=Ne,e.beginPath(),e.moveTo(-o.neckHalfW-4,U-3),e.quadraticCurveTo(-Xe*.79,U-2,-Xe,te),e.quadraticCurveTo(-Xe,te+15,-o.chestHalfW,U+o.torsoLen*.32),e.bezierCurveTo(-o.chestHalfW+2,U+o.torsoLen*.5,-o.waistHalfW,K-12,-o.waistHalfW,K),e.quadraticCurveTo(-o.waistHalfW,(K+ne)*.5,-o.hipHalfW,ne),e.lineTo(o.hipHalfW,ne),e.quadraticCurveTo(o.waistHalfW,(K+ne)*.5,o.waistHalfW,K),e.bezierCurveTo(o.waistHalfW,K-12,o.chestHalfW-2,U+o.torsoLen*.5,o.chestHalfW,U+o.torsoLen*.32),e.quadraticCurveTo(Xe,te+15,Xe,te),e.quadraticCurveTo(Xe*.79,U-2,o.neckHalfW+4,U-3),e.quadraticCurveTo(0,U+14,-o.neckHalfW-4,U-3),e.closePath(),e.fill(),e.strokeStyle="rgba(255, 255, 255, 0.14)",e.lineWidth=1.3,e.stroke(),j!=="apron"&&pn.some(({id:T})=>T===j)){let T=Je(l.wardrobe?.bottomColor,Fe(D,[36,28,48],.42)),O=Je(l.wardrobe?.bottomAccent,A),S=Math.max(o.hipHalfW,o.waistHalfW)+2;e.save(),e.clip(),e.fillStyle=R(T),e.fillRect(-S,dt,S*2,ne-dt),!We&&j!=="field_overshirt"&&(e.fillStyle=R(Fe(T,O,.22)),e.fillRect(-S,K,S*2,J(1.7)-K)),e.restore()}function Ht(T,O,S,b){let N=U+2,G=2*J(O)-N;e.fillStyle=he,e.beginPath(),e.moveTo(-T,N),e.quadraticCurveTo(-o.neckHalfW-6,U-1,-o.neckHalfW,U-5),e.lineTo(o.neckHalfW,U-5),e.quadraticCurveTo(o.neckHalfW+6,U-1,T,N),e.quadraticCurveTo(0,G,-T,N),e.closePath(),e.fill(),e.strokeStyle=S,e.lineWidth=b,e.beginPath(),e.moveTo(-T,N),e.quadraticCurveTo(0,G,T,N),e.stroke()}if(["rugby_shirt","track_jacket","field_overshirt"].includes(j)){e.save(),e.clip();let T=o.shoulderHalfW+8,O=R(A),S=R(Fe(D,M,.32));if(j==="rugby_shirt"){e.fillStyle=O;for(let b of[.43,1.04]){let N=J(b);e.fillRect(-T,N,2*T,J(b+.26)-N),e.fillRect(-T,J(b+.3),2*T,1.6)}}else if(j==="track_jacket"){e.strokeStyle=O,e.lineWidth=J(.135)-U,e.beginPath();let b=o.shoulderHalfW*.85;e.moveTo(-b,J(.38)),e.quadraticCurveTo(0,J(1.16),b,J(.38)),e.stroke(),e.fillStyle=R(se(D,.6)),e.fillRect(-1.8,U,3.6,K-U),e.fillStyle=R(Fe(A,[179,183,189],.42)),e.fillRect(-.8,U,1.6,K-U),e.fillStyle=O,e.fillRect(-1.9,J(.31),3.8,6),e.fillStyle=R(Fe(D,[51,45,67],.35)),e.fillRect(-T,J(1.47),2*T,K-J(1.47))}else{let b=o.chestHalfW*.52,N=J(.62);e.fillStyle=S,e.fillRect(-2.8,U,5.6,dt-U);for(let G of[-1,1]){let z=G*o.chestHalfW*.54-b*.5;e.fillStyle=R(Fe(D,A,.2)),e.beginPath(),e.roundRect(z,N,b,o.torsoLen*.17,[0,0,4,4]),e.fill(),e.fillStyle=R(se(D,.65)),e.fillRect(z-.7,N,b+1.4,4.5)}e.fillStyle=R(Fe(D,[48,40,61],.5));for(let G=0;G<5;G++)e.beginPath(),e.arc(0,U+o.torsoLen*(.16+G*.135),1.9,0,Math.PI*2),e.fill()}if(j!=="track_jacket"){e.fillStyle=j==="rugby_shirt"?R(M):S;for(let b of[-1,1])e.beginPath(),e.moveTo(b*1.8,U+5),e.lineTo(b*(o.neckHalfW+5),U-3),e.lineTo(b*(o.neckHalfW+15),J(.15)),e.lineTo(b*o.neckHalfW*.98,J(.31)),e.closePath(),e.fill()}if(e.restore(),j==="rugby_shirt"){e.fillStyle=R(Fe(D,A,.65)),e.fillRect(-2.8,J(.09),5.6,J(.5)-J(.09)),e.fillStyle=O;for(let b of[.24,.37])e.beginPath(),e.arc(0,J(b),1.2,0,Math.PI*2),e.fill()}else j==="track_jacket"&&(e.strokeStyle=O,e.lineWidth=2,e.beginPath(),e.moveTo(-o.neckHalfW-2,U-3),e.quadraticCurveTo(0,U+7,o.neckHalfW+2,U-3),e.stroke())}else if(We){let T=J(j==="suit_tie"?1.31:1.08),O=o.chestHalfW*.5,S=R(Fe(D,A,j==="jacket"?.58:.17));if(e.beginPath(),e.moveTo(-o.neckHalfW,U-4),e.quadraticCurveTo(-O*.99,U+3,-O,U+10),e.lineTo(0,T),e.lineTo(O,U+10),e.quadraticCurveTo(O*.99,U+3,o.neckHalfW,U-4),e.quadraticCurveTo(0,U+4,-o.neckHalfW,U-4),e.closePath(),e.fillStyle=R(M),e.fill(),e.strokeStyle=S,e.lineWidth=j==="cardigan"?3:1.5,e.lineJoin="round",e.stroke(),e.beginPath(),e.moveTo(0,T),e.lineTo(0,dt),e.stroke(),j==="blazer"||j==="suit_tie"){e.fillStyle=R(Fe(D,[214,212,231],.16));for(let b of[-1,1])e.beginPath(),e.moveTo(b*o.neckHalfW,U-4),e.lineTo(b*(O+13),J(.2)),e.lineTo(b*(O+4),J(.31)),e.lineTo(b*(O+11),J(.37)),e.lineTo(0,T),e.lineTo(b*O,U+10),e.closePath(),e.fill()}if(j==="suit_tie"&&l.neckwear!=="bowtie")e.fillStyle=R(A),e.beginPath(),e.moveTo(-5.8,J(.12)),e.lineTo(5.8,J(.12)),e.lineTo(3.5,J(.26)),e.lineTo(6.2,J(1.11)),e.lineTo(0,J(1.23)),e.lineTo(-6.2,J(1.11)),e.lineTo(-3.5,J(.26)),e.closePath(),e.fill();else if(j==="cardigan"){e.fillStyle=R(A);for(let b of[1.12,1.45,1.78])e.beginPath(),e.arc(.8,J(b),2.3,0,Math.PI*2),e.fill()}else if(j==="jacket"){e.strokeStyle=R(A),e.lineWidth=1.3;for(let b=J(.42);b<dt;b+=4){let N=O*Math.max(0,(T-b)/(T-U-10));for(let G of[-1,1])e.beginPath(),e.moveTo(G*N,b),e.lineTo(G*(N+2.2),b+.8),e.stroke()}}}else if(j==="turtleneck"||j==="hoodie"){let T=j==="hoodie",O=o.neckHalfW*(T?1.45:1.03),S=J(T?-.15:-.24);if(e.fillStyle=Ne,e.beginPath(),e.moveTo(-O,S),e.quadraticCurveTo(0,S+3.5,O,S),e.lineTo(O+(T?7:1),J(.11)),e.quadraticCurveTo(0,J(T?.23:.16),-O-(T?7:1),J(.11)),e.closePath(),e.fill(),e.strokeStyle=R(se(D,1.22)),e.lineWidth=1.5,e.beginPath(),e.moveTo(-O,S),e.quadraticCurveTo(0,S+3.5,O,S),e.stroke(),T){for(let b of[-1,1]){let N=o.chestHalfW*.3*b;e.strokeStyle=R(M),e.lineWidth=2,e.beginPath(),e.moveTo(N*1.16,J(.15)),e.quadraticCurveTo(N*.82,J(.53),N,J(.82)),e.stroke(),e.strokeStyle=R(A),e.lineWidth=2.6,e.beginPath(),e.moveTo(N*.94,J(.71)),e.lineTo(N,J(.82)),e.stroke()}e.fillStyle=R(Fe(D,[48,40,61],.27)),e.beginPath(),e.moveTo(-o.waistHalfW*.43,J(1.16)),e.lineTo(o.waistHalfW*.43,J(1.16)),e.lineTo(o.waistHalfW*.7,J(1.38)),e.lineTo(o.waistHalfW*.7,K),e.lineTo(-o.waistHalfW*.7,K),e.lineTo(-o.waistHalfW*.7,J(1.38)),e.closePath(),e.fill()}}else if(j==="sweater")Ht(o.neckHalfW+2,.1,R(se(D,1.16)),3.2);else if(j==="polo"||j==="shirt"){let T=j==="shirt";e.fillStyle=R(Fe(D,[48,40,61],.27)),e.fillRect(-1.9,J(.19),3.8,J(T?1.57:.81)-J(.19)),e.fillStyle=R(M);for(let S of T?[.46,.71,.96,1.21,1.46]:[.46,.69])e.beginPath(),e.arc(0,J(S),1.55,0,Math.PI*2),e.fill();T&&(e.fillStyle=R(Fe(D,M,.2)),e.beginPath(),e.moveTo(-o.chestHalfW*.7,J(.61)),e.lineTo(-o.chestHalfW*.33,J(.61)),e.lineTo(-o.chestHalfW*.34,J(.84)),e.lineTo(-o.chestHalfW*.5,J(.91)),e.lineTo(-o.chestHalfW*.68,J(.84)),e.closePath(),e.fill());let O=Fe(D,A,.15);e.fillStyle=R(O),e.strokeStyle=R(Fe(O,A,.65)),e.lineWidth=1;for(let S of[-1,1])e.beginPath(),e.moveTo(0,J(.17)),e.lineTo(S*o.neckHalfW*.87,U-3),e.quadraticCurveTo(S*o.neckHalfW*1.68,U-1,S*o.chestHalfW*.64,J(.17)),e.lineTo(S*o.chestHalfW*.42,J(.34)),e.closePath(),e.fill(),e.beginPath(),e.moveTo(S*o.chestHalfW*.64,J(.17)),e.lineTo(S*o.chestHalfW*.42,J(.34)),e.stroke()}else if(j==="scoop"){let T=Math.min(o.shoulderHalfW*.79,o.chestHalfW*.81);Ht(T,.56,R(se(D,1.22)),2),e.strokeStyle=R(q,.22),e.lineWidth=1.1;for(let O of[-1,1])e.beginPath(),e.moveTo(O*6,U+12),e.quadraticCurveTo(O*16,U+8.5,O*(T-5),U+6),e.stroke()}else if(j==="apron"){Ht(o.neckHalfW+8,.26,R(se(D,.84)),2);let T=J(.48),O=o.chestHalfW*.5;e.strokeStyle=R(M),e.lineWidth=4.8,e.lineCap="round";for(let N of[-1,1])e.beginPath(),e.moveTo(N*(o.neckHalfW+2),U-1),e.lineTo(N*(O-3),T+2),e.stroke();let S=e.createLinearGradient(0,T,0,ne);S.addColorStop(0,R(M)),S.addColorStop(1,R(se(M,.8))),e.fillStyle=S,e.beginPath(),e.moveTo(-O,T),e.lineTo(O,T),e.quadraticCurveTo(O+4,K-10,o.waistHalfW+1,K+2),e.lineTo(o.hipHalfW,ne),e.lineTo(-o.hipHalfW,ne),e.lineTo(-o.waistHalfW-1,K+2),e.quadraticCurveTo(-O-4,K-10,-O,T),e.closePath(),e.fill();let b=o.chestHalfW*.3;e.fillStyle=R(Fe(M,D,.22)),e.beginPath(),e.moveTo(-b,J(.77)),e.lineTo(b,J(.77)),e.lineTo(b*.96,J(1.02)),e.lineTo(b*.7,J(1.11)),e.lineTo(-b*.7,J(1.11)),e.lineTo(-b*.96,J(1.02)),e.closePath(),e.fill(),e.fillStyle=R(A),e.beginPath(),e.rect(-b,J(.78),b*2,J(.82)-J(.78)),e.fill()}else j==="tee"?(Ht(o.neckHalfW+8,.26,R(se(D,.78)),2.5),e.fillStyle=R(A,.94),e.beginPath(),e.arc(0,J(.78),10.5,0,Math.PI*2),e.fill(),e.fillStyle=R(M,.92),e.beginPath(),e.arc(0,J(.78),4.6,0,Math.PI*2),e.fill()):j==="cyber"&&(e.strokeStyle=R(A),e.lineWidth=2.4,e.beginPath(),e.moveTo(-o.chestHalfW*.7,J(.32)),e.lineTo(-o.chestHalfW*.2,J(.6)),e.lineTo(o.chestHalfW*.2,J(.6)),e.lineTo(o.chestHalfW*.7,J(.32)),e.stroke(),e.fillStyle=R(Fe(D,A,.44)),e.beginPath(),e.arc(0,J(.6),5.6,0,Math.PI*2),e.fill(),e.fillStyle=R(A,.85+n.voicing*.15),e.beginPath(),e.arc(0,J(.6),3.2,0,Math.PI*2),e.fill());l.nameBadge&&j!=="cyber"&&j!=="apron"&&(e.fillStyle=R(A),e.beginPath(),e.roundRect(o.chestHalfW*.37,J(.52),o.chestHalfW*.31,J(.62)-J(.52),1.9),e.fill());let it=l.brooch||"none";if(it!=="none"&&j!=="cyber"){let T=Je(l.broochColor,[230,195,92]),O=-o.chestHalfW*.4,S=U+29;if(e.fillStyle=R(T),e.strokeStyle=R(se(T,.62),.8),e.lineWidth=.8,e.beginPath(),it==="star"){for(let b=0;b<10;b++){let N=b%2?2.9:6.6,G=b/10*Math.PI*2-Math.PI/2;e[b?"lineTo":"moveTo"](O+Math.cos(G)*N,S+Math.sin(G)*N)}e.closePath()}else if(it==="heart")e.moveTo(O,S+5.8),e.bezierCurveTo(O-9.5,S-.5,O-4.4,S-7.6,O,S-2.6),e.bezierCurveTo(O+4.4,S-7.6,O+9.5,S-.5,O,S+5.8);else if(it==="flower")for(let b=0;b<5;b++){let N=b/5*Math.PI*2-Math.PI/2;e.moveTo(O+Math.cos(N)*3.9+3,S+Math.sin(N)*3.9),e.arc(O+Math.cos(N)*3.9,S+Math.sin(N)*3.9,3,0,Math.PI*2)}else e.arc(O,S,4.8,0,Math.PI*2);e.fill(),e.stroke(),e.fillStyle=it==="flower"?R(se(T,.6)):"rgba(255, 255, 255, 0.55)",e.beginPath(),e.arc(it==="flower"?O:O-1.4,it==="flower"?S:S-1.6,it==="flower"?2.2:1.2,0,Math.PI*2),e.fill()}let Kt=l.neckwear||"none";if(Kt!=="none"){let T=Je(l.neckwearColor,[217,164,65]);if(Kt==="necklace")e.strokeStyle=R(T),e.lineWidth=1.2,e.beginPath(),e.moveTo(-o.neckHalfW+1.5,U-6),e.quadraticCurveTo(0,U+19,o.neckHalfW-1.5,U-6),e.stroke(),e.fillStyle=R(T),e.beginPath(),e.moveTo(0,U+9),e.quadraticCurveTo(4.4,U+14.5,0,U+18.5),e.quadraticCurveTo(-4.4,U+14.5,0,U+9),e.fill(),e.fillStyle="rgba(255, 255, 255, 0.6)",e.beginPath(),e.arc(-1,U+12.6,1,0,Math.PI*2),e.fill();else if(Kt==="bowtie"){e.fillStyle=R(T);for(let O of[-1,1])e.beginPath(),e.moveTo(O*2,U+5.5),e.quadraticCurveTo(O*9,U-3.5,O*15,U-.5),e.lineTo(O*15,U+12),e.quadraticCurveTo(O*9,U+14.5,O*2,U+6.5),e.closePath(),e.fill();e.fillStyle=R(se(T,.74)),e.beginPath(),e.roundRect(-3.2,U+1.2,6.4,9.6,2.4),e.fill()}else if(Kt==="scarf"){let O=e.createLinearGradient(0,U-22,0,U+12);O.addColorStop(0,R(se(T,1.16))),O.addColorStop(1,R(se(T,.78))),e.fillStyle=O,e.beginPath(),e.moveTo(-o.neckHalfW-9,U-13),e.quadraticCurveTo(0,U-23,o.neckHalfW+9,U-13),e.quadraticCurveTo(o.neckHalfW+14,U+1,o.neckHalfW+6,U+9),e.quadraticCurveTo(0,U+19,-o.neckHalfW-6,U+9),e.quadraticCurveTo(-o.neckHalfW-14,U+1,-o.neckHalfW-9,U-13),e.closePath(),e.fill(),e.fillStyle=R(se(T,.88)),e.beginPath(),e.moveTo(4,U+8),e.lineTo(17,U+6),e.lineTo(21,U+52),e.lineTo(8,U+54),e.closePath(),e.fill(),e.strokeStyle=R(se(T,.62),.7),e.lineWidth=1;for(let S of[U-6,U+2])e.beginPath(),e.moveTo(-o.neckHalfW-7,S),e.quadraticCurveTo(0,S+8,o.neckHalfW+7,S),e.stroke()}else if(Kt==="lanyard"){let O=U+56;e.strokeStyle=R(T),e.lineWidth=2.4,e.lineCap="round";for(let S of[-1,1])e.beginPath(),e.moveTo(S*(o.neckHalfW+1),U-2),e.lineTo(0,O),e.stroke();e.fillStyle="#f8fafc",e.strokeStyle="rgba(15, 23, 42, 0.28)",e.lineWidth=.9,e.beginPath(),e.roundRect(-10,O-2,20,26,2.6),e.fill(),e.stroke(),e.fillStyle=R(T),e.fillRect(-10,O-2,20,6),e.fillStyle=R(k),e.beginPath(),e.arc(0,O+10,3.4,0,Math.PI*2),e.fill(),e.fillStyle="rgba(15, 23, 42, 0.5)",e.fillRect(-6,O+16.5,12,1.6),e.fillRect(-4,O+19.6,8,1.4)}}if(l.hairStyle==="braids"){e.save(),ye();for(let T of[-1,1]){let O=T*(o.headW-1.5)-ae*.3,S=8,b=U+54,N=Math.max(8,Math.round((b-S)/8.5));for(let z=0;z<N;z++){let pe=z/(N-1),Ce=S+(b-S)*pe,xe=O+T*Math.sin(pe*2.2)*5+Math.sin(d*1.5+pe*3)*.6,tt=8.4-pe*2.6,Et=(z%2?1:-1)*.62;e.fillStyle=R(se(Q,z%2?.8:1.08)),e.beginPath(),e.ellipse(xe+(z%2?1.4:-1.4),Ce,tt*.82,tt*1.12,Et,0,Math.PI*2),e.fill(),e.strokeStyle=R(se(Q,.56),.55),e.lineWidth=.8,e.stroke()}let G=O+T*Math.sin(2.2)*5;e.fillStyle=R(A),e.beginPath(),e.roundRect(G-4,b+1,8,4,2),e.fill(),e.fillStyle=R(se(Q,.9)),e.beginPath(),e.moveTo(G-3.4,b+5),e.quadraticCurveTo(G,b+17,G+3.4,b+5),e.fill()}e.restore()}for(let{elbow:T,wrist:O,dir:S,wristBend:b,gesture:N}of je){let G=o.armThick,z=Math.atan2(T.x-O.x,O.y-T.y)+b,pe=le(G/15,.78,1.28);ea(e,T,O,G*(me?.57:.71),G*(me?.32:.45),...me?He:ke,me?null:Pe),j==="track_jacket"&&(e.strokeStyle=R(A),e.lineWidth=G*.17,e.beginPath(),e.moveTo(T.x+S*G*.39,T.y),e.lineTo(O.x+S*G*.25,O.y-1),e.stroke()),Ei(e,O,z,pe,-S,N,...He)}if(e.save(),e.translate(ae*.35,ee+Oe*.4),e.rotate(v),["side_sweep","quiff","pixie","buzz","updo_bun","ponytail","pigtails","space_buns","mohawk"].includes(l.hairStyle)){let T=e.createLinearGradient(0,-o.headH-28,0,18);if(T.addColorStop(0,R(se(Q,1.15))),T.addColorStop(1,R(se(Q,.62))),e.fillStyle=T,e.save(),ye(),l.hairStyle==="updo_bun"&&(e.beginPath(),e.arc(-ae*.35,-o.headH-12,20*o.headScale,0,Math.PI*2),e.fill()),l.hairStyle==="space_buns")for(let S of[-1,1])e.beginPath(),e.arc(S*o.headW*.7-ae*.35,-o.headH-8,15*o.headScale,0,Math.PI*2),e.fill();let O=l.hairStyle==="buzz"||l.hairStyle==="mohawk"?2.2:5.5;e.beginPath(),e.moveTo(-o.headW-O,-10),e.bezierCurveTo(-o.headW-O-4,-o.headH-14,o.headW+O+4,-o.headH-14,o.headW+O,-10),e.lineTo(o.headW-2,16),e.lineTo(-o.headW+2,16),e.closePath(),e.fill(),e.restore()}let Te=le(l.earSize??1,.65,1.45)*o.headScale;for(let T of[-1,1]){let O=T*(o.headW-.5)-ae*.42,S=-2;if(l.earStyle==="cyber"){e.fillStyle=R(D),e.strokeStyle=R(A,.85),e.lineWidth=1.6,e.beginPath(),e.roundRect(O-5*Te,S-14*Te,10*Te,28*Te,4*Te),e.fill(),e.stroke();continue}let b=e.createLinearGradient(O,S-16*Te,O,S+15*Te);b.addColorStop(0,R(Y)),b.addColorStop(1,R(C)),e.fillStyle=b,e.beginPath(),l.earStyle==="pointed"?(e.moveTo(O-T*4*Te,S-11*Te),e.quadraticCurveTo(O+T*15*Te,S-22*Te,O+T*13*Te,S-4*Te),e.quadraticCurveTo(O+T*8*Te,S+14*Te,O-T*3*Te,S+14*Te),e.closePath()):e.ellipse(O,S,8.5*Te,15.8*Te,T*-.09,0,Math.PI*2),e.fill(),e.fillStyle=R(q,.34),e.beginPath(),e.ellipse(O-T*1.2*Te,S+1,4*Te,8.8*Te,T*-.08,0,Math.PI*2),e.fill()}let ca=e.createRadialGradient(-14+ae*.3,-26*o.headScale,8,0,6,o.headH*1.48);ca.addColorStop(0,R(Y)),ca.addColorStop(.54,R(k)),ca.addColorStop(.88,R(C)),ca.addColorStop(1,R(q));let La=(6+le(l.chinRoundness??.65,0,1)*15)*o.headScale;e.fillStyle=ca,e.beginPath(),e.moveTo(-o.headW,-20*o.headScale),e.bezierCurveTo(-o.headW,-o.headH-4,o.headW,-o.headH-4,o.headW,-20*o.headScale),e.bezierCurveTo(o.cheekW+1.5,-2,o.cheekW,14*o.headScale,o.jawW+3,34*o.headScale+ce*.45),e.bezierCurveTo(o.jawW-4,48*o.headScale+ce*.78,La,ve-.8,0,ve+2.8),e.bezierCurveTo(-La,ve-.8,-o.jawW+4,48*o.headScale+ce*.78,-o.jawW-3,34*o.headScale+ce*.45),e.bezierCurveTo(-o.cheekW,14*o.headScale,-o.cheekW-1.5,-2,-o.headW,-20*o.headScale),e.closePath(),e.fill(),e.strokeStyle=R(q,.28),e.lineWidth=1.25,e.stroke();let Yt=l.earrings||"none";if(Yt!=="none"&&l.earStyle!=="cyber"&&ue!=="headscarf"){let T=Je(l.earringColor,[230,195,92]);for(let O of[-1,1]){let S=O*(o.headW+2.2*Te)-ae*.42,b=11.5*Te;if(e.fillStyle=R(T),e.strokeStyle=R(T),Yt==="studs")e.beginPath(),e.arc(S,b,2.5*Te,0,Math.PI*2),e.fill();else if(Yt==="hoops")e.lineWidth=1.7*Te,e.beginPath(),e.arc(S+O*.8,b+6.5*Te,6*Te,0,Math.PI*2),e.stroke();else{let N=(n.lookX*1.8+W("shake")*Math.sin(d*13-.8)*3)*Te;e.lineWidth=1,e.beginPath(),e.moveTo(S,b),e.lineTo(S+N*.5,b+6*Te),e.stroke(),e.beginPath(),e.moveTo(S+N*.5,b+5*Te),e.quadraticCurveTo(S+N+3.6*Te,b+12*Te,S+N,b+14.5*Te),e.quadraticCurveTo(S+N-3.6*Te,b+12*Te,S+N*.5,b+5*Te),e.fill()}e.fillStyle="rgba(255, 255, 255, 0.55)",e.beginPath(),e.arc(S-.7*Te,b-.7*Te+(Yt==="drops"?11*Te:0),.9*Te,0,Math.PI*2),e.fill()}}let ya=e.createRadialGradient(-10+ae*.5,-34*o.headScale,2,-6+ae*.4,-32*o.headScale,29*o.headScale);ya.addColorStop(0,`rgba(255, 248, 244, ${.26+w*.22})`),ya.addColorStop(1,"rgba(255, 248, 244, 0)"),e.fillStyle=ya,e.beginPath(),e.ellipse(-6+ae*.4,-32*o.headScale,28*o.headScale,15*o.headScale,-.1,0,Math.PI*2),e.fill(),e.save(),e.translate(ae*.65,Oe*.6);let Vt=n.lipS*3.6+X*3.2-W("frown")*4.4,va=le(l.blushIntensity??.2,0,.65);if(va>.01)for(let T of[-1,1]){let O=T*29*o.headScale,S=9*o.headScale-Vt*.5,b=e.createRadialGradient(O,S,2,O,S,18*o.headScale);b.addColorStop(0,`rgba(232, 104, 116, ${va})`),b.addColorStop(1,"rgba(232, 104, 116, 0)"),e.fillStyle=b,e.beginPath(),e.arc(O,S,18*o.headScale,0,Math.PI*2),e.fill()}let Ya=le(l.freckles??0,0,1);if(Ya>.02){e.fillStyle=R(se(k,.62,.5),.2+Ya*.42);let T=Math.round(ds.length*(.35+Ya*.65));for(let O=0;O<T;O++){let[S,b,N]=ds[O];e.beginPath(),e.arc(S*o.headScale,b*o.headScale-Vt*.3,N*o.headScale,0,Math.PI*2),e.fill()}}let Aa=le(l.ageLines??0,0,1);if(Aa>.02){let T=o.headScale;e.strokeStyle=R(q,.16+Aa*.4),e.lineCap="round",e.lineWidth=.9+Aa*.5;for(let O of[-39,-45.5])e.beginPath(),e.moveTo(-17*T,O*T),e.quadraticCurveTo(0,(O-2.2)*T,17*T,O*T),e.stroke();for(let O of[-1,1]){for(let[S,b]of[[-3,5],[0,6],[3,5]])e.beginPath(),e.moveTo(O*35.5*T,(-12+S*.5)*T),e.lineTo(O*(35.5+b)*T,(-12+S*1.5)*T),e.stroke();e.beginPath(),e.moveTo(O*13*T,-4.5*T),e.quadraticCurveTo(O*22*T,-1.5*T,O*30*T,-5*T),e.stroke(),e.beginPath(),e.moveTo(O*12*T,12*T),e.quadraticCurveTo(O*23*T,21*T-Vt*.4,O*25*T,33*T-Vt*.6+ce*.3),e.stroke()}}l.beautyMark&&(e.fillStyle=R(se(q,.5),.82),e.beginPath(),e.arc(-17.5*o.headScale,24.5*o.headScale-Vt*.5+ce*.2,1.25*o.headScale,0,Math.PI*2),e.fill());let Ta=l.browColor?Je(l.browColor,se(Q,.85)):se(Q,.85),wt=l.facialHair||"none";if(wt==="stubble"||wt==="beard"||wt==="goatee"){let T=wt==="stubble"?.22:.88;if(e.fillStyle=R(Ta,T),e.beginPath(),wt==="goatee")e.ellipse(0,ve-9,16*o.headScale,14*o.headScale,0,0,Math.PI*2);else{let O=14*o.headScale;e.moveTo(-o.cheekW+2,O),e.quadraticCurveTo(-o.jawW+6,28*o.headScale+ce*.3,-18*o.headScale,25*o.headScale+ce*.25),e.quadraticCurveTo(0,22*o.headScale+ce*.22,18*o.headScale,25*o.headScale+ce*.25),e.quadraticCurveTo(o.jawW-6,28*o.headScale+ce*.3,o.cheekW-2,O),e.bezierCurveTo(o.cheekW,28*o.headScale,o.jawW+2,46*o.headScale+ce*.75,0,ve+3.5),e.bezierCurveTo(-o.jawW-2,46*o.headScale+ce*.75,-o.cheekW,28*o.headScale,-o.cheekW+2,O),e.closePath()}e.fill()}let Ua=r-n.blinkStartMs,To=Ua>=0&&Ua<145?Math.sin(Ua/145*Math.PI):0,Ve=le(l.eyeSize??1,.75,1.38)*o.headScale,L=21.5*le(l.eyeSpacing??1,.8,1.24)*o.headScale,re=le(l.eyeTilt??.04,-.3,.35),be=le(n.pitchSt*.85+n.energy*2.4+W("browUp")*5.2,-2.5,8.5),Ue=le(l.eyeshadow??0,0,1),Me=Je(l.eyeshadowColor,[122,92,143]),Qe=Je(l.irisColor,[59,130,166]),_e=l.irisColor2?Je(l.irisColor2,Qe):Qe,mt=le(l.eyeliner??0,0,1);for(let T of[-1,1]){let O=T*L,S=-12.5*o.headScale,b=T===1?W("wink")*.94:0,N=Math.max(To,b,W("shut")*.96),G=Math.max(.55,6.2*Ve*(1+$*.34)*(1-N*.94)),z=11.4*Ve,pe=-re*5.5,Ce=T===1?_e:Qe,xe=e.createRadialGradient(O,S-1,2,O,S-1,15*Ve);if(xe.addColorStop(0,R(q,.18)),xe.addColorStop(1,R(q,0)),e.fillStyle=xe,e.beginPath(),e.ellipse(O,S-1,15*Ve,11*Ve,0,0,Math.PI*2),e.fill(),Ue>.02){let en=e.createLinearGradient(O,S-G*1.5-7.5*Ve,O,S-G*.6);en.addColorStop(0,R(Me,0)),en.addColorStop(1,R(Me,.3+Ue*.5)),e.fillStyle=en,e.beginPath(),e.moveTo(O-T*(z+.5),S+.4),e.quadraticCurveTo(O-T*2,S-G*1.5-8.5*Ve,O+T*(z+3.2),S-1.2+pe),e.quadraticCurveTo(O,S-G*1.46,O-T*(z+.5),S+.4),e.closePath(),e.fill()}e.strokeStyle=R(q,.36),e.lineWidth=1.05,e.beginPath(),e.moveTo(O-T*z*.92,S-2.8-G*.52),e.quadraticCurveTo(O,S-5.8-G*.85,O+T*z*.95,S-2.6-G*.52+pe*.6),e.stroke(),e.save(),e.beginPath(),e.moveTo(O-T*z,S+.6),e.quadraticCurveTo(O,S-G*1.46,O+T*z,S+.4+pe),e.quadraticCurveTo(O,S+G*1.16,O-T*z,S+.6),e.closePath();let tt=e.createLinearGradient(O,S-G,O,S+G);tt.addColorStop(0,"#d6dce8"),tt.addColorStop(.35,"#f9fafe"),tt.addColorStop(1,"#ebeff7"),e.fillStyle=tt,e.fill(),e.clip();let Et=O+n.lookX*3.2*Ve,Nt=S+n.lookY*2.1*Ve,xa=5.6*Ve,Io=e.createRadialGradient(Et-1.2*Ve,Nt-1.4*Ve,.7*Ve,Et,Nt,xa);Io.addColorStop(0,R(se(Ce,1.38))),Io.addColorStop(.68,R(Ce)),Io.addColorStop(1,R(se(Ce,.36))),e.fillStyle=Io,e.beginPath(),e.arc(Et,Nt,xa,0,Math.PI*2),e.fill(),e.fillStyle="#090c14",e.beginPath(),e.arc(Et,Nt,2.45*Ve,0,Math.PI*2),e.fill(),e.fillStyle="rgba(255, 255, 255, 0.95)",e.beginPath(),e.arc(Et-1.8*Ve,Nt-1.9*Ve,1.45*Ve,0,Math.PI*2),e.fill(),e.fillStyle="rgba(255, 255, 255, 0.56)",e.beginPath(),e.arc(Et+1.9*Ve,Nt+1.5*Ve,.78*Ve,0,Math.PI*2),e.fill(),e.restore();let So=l.lashStyle||"classic";e.strokeStyle="#17141f",e.lineWidth=(So==="lush"?2.45:So==="classic"?1.95:1.55)*Math.sqrt(Ve),e.lineCap="round",e.beginPath(),e.moveTo(O-T*(z+.3),S+.6),e.quadraticCurveTo(O,S-G*1.48,O+T*(z+(So==="lush"?1.9:.4)),S+.3+pe-(So==="lush"?1:0)),e.stroke(),mt>.02&&(e.strokeStyle=`rgba(23, 20, 31, ${.6+mt*.4})`,e.lineWidth=(1.2+mt*1.5)*Math.sqrt(Ve),e.beginPath(),e.moveTo(O+T*(z-3),S-.6+pe*.8),e.quadraticCurveTo(O+T*(z+1.5),S-.2+pe,O+T*(z+2.6+mt*3.6),S-1.4-mt*3+pe),e.stroke());let oi=le(l.browThickness??1,.5,1.65),os=le(l.browArch??.2,-.2,.6)*10,eo=S-(12.8+be)*o.headScale,ns=3*oi*o.headScale,ss=-oe*3.6*o.headScale,ni=oe*1.5*o.headScale;e.fillStyle=R(Ta),e.beginPath(),e.moveTo(O-T*(z+.5),eo+1.8+ss),e.quadraticCurveTo(O+T*2,eo-3-os,O+T*(z+2.4),eo+1.5+ni),e.quadraticCurveTo(O+T*2,eo-3-os+ns,O-T*z,eo+1.8+ns*.82+ss),e.closePath(),e.fill()}let ha=le(l.noseLength??1,.76,1.28)*o.headScale,$e=le(l.noseWidth??1,.72,1.35)*o.headScale,et=10.2*ha,Ia=e.createLinearGradient(-7*$e,-13,6*$e,et+3);Ia.addColorStop(0,R(q,.05)),Ia.addColorStop(1,R(q,.26)),e.fillStyle=Ia,e.beginPath(),e.moveTo(1,-13*o.headScale),e.quadraticCurveTo(6.5*$e,1,9.2*$e,et-.6),e.quadraticCurveTo(3*$e,et+4.2,0,et+3.2),e.closePath(),e.fill(),e.fillStyle=R(q,.3),e.beginPath(),e.moveTo(-9.2*$e,et),e.quadraticCurveTo(0,et+5.8,9.2*$e,et),e.quadraticCurveTo(0,et+3,-9.2*$e,et),e.closePath(),e.fill(),e.fillStyle="rgba(56, 24, 20, 0.62)";for(let T of[-1,1])e.beginPath(),e.ellipse(T*4.5*$e,et+1.1,2.2*$e,1.1,T*-.28,0,Math.PI*2),e.fill();if(l.noseStud){let T=Je(l.earringColor,[230,195,92]);e.fillStyle=R(T),e.beginPath(),e.arc(7.4*$e,et-2.2,1.35,0,Math.PI*2),e.fill(),e.fillStyle="rgba(255, 255, 255, 0.75)",e.beginPath(),e.arc(7*$e,et-2.6,.5,0,Math.PI*2),e.fill()}e.strokeStyle=R(q,.38),e.lineWidth=1.2,e.beginPath(),e.arc(-6.3*$e,et-.5,3.2*$e,Math.PI*.55,Math.PI*1.45),e.stroke(),e.beginPath(),e.arc(6.3*$e,et-.5,3.2*$e,-Math.PI*.45,Math.PI*.45),e.stroke(),e.strokeStyle="rgba(255, 246, 240, 0.38)",e.lineWidth=2.1,e.lineCap="round",e.beginPath(),e.moveTo(-.8,-10*o.headScale),e.lineTo(-.9,et-4.4),e.stroke(),e.fillStyle="rgba(255, 246, 240, 0.35)",e.beginPath(),e.ellipse(-.5,et-1.4,3.1*$e,2.3,0,0,Math.PI*2),e.fill(),e.fillStyle=R(q,.14),e.beginPath(),e.ellipse(0,(et+29*o.headScale)*.5,2.6,4.6*o.headScale,0,0,Math.PI*2),e.fill();let Ja=30.8*o.headScale+ce*.3,It=le(l.mouthWidth??1,.76,1.3)*o.headScale,Qa=le(l.lipFullness??1,.65,1.52)*o.headScale,Zt=n.phone==="F"||n.phone==="V",Za=n.lipR,xo=n.lipS,ai=Zt?Math.min(.68,n.lipC):n.lipC,Be=(20.2+xo*8.6-Za*7+X*1.8-W("frown")*1.2)*It,es=(1.1+n.jaw*21)*(1-ai*.97)*o.headScale,xt=Math.max(Zt?2.6*o.headScale:.24,es),ft=Ja-Vt*.85+Za*1.4,St=Ja-xt*.44,Ut=Ja+xt*.56,Ca=((Zt?4.1:5.6)+Za*2.4-xo*.8)*Qa,Da=(4.4+Za*2.1-xo*.7)*Qa;if(e.fillStyle=R(q,.24),e.beginPath(),e.ellipse(0,Ut+Ca+3,Be*.52,2.3,0,0,Math.PI*2),e.fill(),xt>.78){e.save(),e.beginPath(),e.moveTo(-Be+1.4,ft),e.quadraticCurveTo(0,St-2.1,Be-1.4,ft),e.quadraticCurveTo(0,Ut+2.4,-Be+1.4,ft),e.closePath(),e.clip();let T=e.createLinearGradient(0,St-4,0,Ut+6);T.addColorStop(0,"#1c0b12"),T.addColorStop(.55,"#361320"),T.addColorStop(1,"#1d0911"),e.fillStyle=T,e.fillRect(-Be-4,St-8,Be*2+8,xt+18);let O=Math.max(n.tH*.72,n.tTip*.96),S=Ut+2-O*(xt*.88+3.4*o.headScale),b=Be*(n.tTip>.6?.58:.78),N=e.createRadialGradient(0,S+5,2,0,S+8,b);N.addColorStop(0,"#f5879b"),N.addColorStop(1,"#b84962"),e.fillStyle=N,e.beginPath(),e.ellipse(0,S+8,b,9.5*o.headScale,0,Math.PI,Math.PI*2),e.fill();let G=Be*.78,z=St+(3.6-Za*1.1)*o.headScale;e.fillStyle="#f7f6f1",e.beginPath(),e.roundRect(-G,St-5,G*2,Math.max(1,z-(St-5)),2.2),e.fill(),e.strokeStyle="rgba(155, 148, 138, 0.34)",e.lineWidth=.7;for(let pe of[-G*.48,0,G*.48])e.beginPath(),e.moveTo(pe,St-4),e.lineTo(pe,z),e.stroke();if(xt>5.4*o.headScale&&!Zt){let pe=Ut-2.3*o.headScale+n.jaw*1.3;e.fillStyle="#eae8e1",e.beginPath(),e.roundRect(-G*.88,pe,G*1.76,6*o.headScale,1.8),e.fill()}e.restore()}let ts=Je(l.lipColor,[214,104,124]);e.fillStyle=R(se(ts,.82)),e.beginPath(),e.moveTo(-Be,ft),e.bezierCurveTo(-Be*.55,St-Da,-5.2*It,St-Da-1.6,0,St-Da+.9),e.bezierCurveTo(5.2*It,St-Da-1.6,Be*.55,St-Da,Be,ft),e.quadraticCurveTo(0,St-(xt<.9?0:1.5),-Be,ft),e.closePath(),e.fill();let Pa=Zt?-1.8*o.headScale:0;e.fillStyle=R(ts),e.beginPath(),e.moveTo(-Be,ft),e.quadraticCurveTo(0,Ut+(xt<.9?.2:1.7)+Pa,Be,ft),e.bezierCurveTo(Be*.62,Ut+Ca+Pa,-Be*.62,Ut+Ca+Pa,-Be,ft),e.closePath(),e.fill(),e.strokeStyle="rgba(255, 238, 242, 0.40)",e.lineWidth=1.45,e.beginPath(),e.moveTo(-7.2*It,Ut+Ca*.48+Pa),e.quadraticCurveTo(0,Ut+Ca*.64+Pa,7.2*It,Ut+Ca*.48+Pa),e.stroke();for(let T of[-1,1])e.fillStyle="rgba(68, 20, 32, 0.42)",e.beginPath(),e.arc(T*(Be+.35),ft,1.45,0,Math.PI*2),e.fill();let as=le(l.dimples??0,0,1);if(as>.02){e.strokeStyle=R(q,(.18+as*.34)*le(.65+Vt*.1,.6,1.25)),e.lineWidth=1.3,e.lineCap="round";for(let T of[-1,1]){let O=T*(Be+5.4*o.headScale);e.beginPath(),e.moveTo(O-T*.6,ft-4.4*o.headScale),e.quadraticCurveTo(O+T*2.8,ft,O-T*.4,ft+4.8*o.headScale),e.stroke()}}if(xt<1.25&&(e.strokeStyle="rgba(68, 20, 32, 0.66)",e.lineWidth=1.35,e.beginPath(),e.moveTo(-Be+1,ft),e.quadraticCurveTo(0,Ja+.4,Be-1,ft),e.stroke()),wt==="mustache"||wt==="beard"||wt==="goatee"){e.fillStyle=R(se(Ta,.97)),e.beginPath();let T=St-Da-2.2;e.moveTo(0,T-2.6),e.quadraticCurveTo(Be*.65,T-3.6,Be+2,ft-1.5),e.quadraticCurveTo(Be*.55,T+2.2,0,T+.8),e.quadraticCurveTo(-Be*.55,T+2.2,-Be-2,ft-1.5),e.quadraticCurveTo(-Be*.65,T-3.6,0,T-2.6),e.closePath(),e.fill()}let bt=l.glasses||"none";if(bt!=="none"){let T=Je(l.glassesColor,[31,36,48]),O=-11.5*o.headScale,S=16.5*Ve,b=11.8*Ve;if(bt==="visor"){let N=e.createLinearGradient(-L-S,O-b,L+S,O+b);N.addColorStop(0,R(T,.58)),N.addColorStop(.5,"rgba(255, 255, 255, 0.35)"),N.addColorStop(1,R(T,.62)),e.fillStyle=N,e.strokeStyle=R(T,.95),e.lineWidth=1.8,e.beginPath(),e.roundRect(-L-S,O-b*.85,(L+S)*2,b*1.75,8),e.fill(),e.stroke()}else{let N=bt==="shades";e.strokeStyle=R(T),e.lineWidth=bt==="bold"?3:bt==="cat_eye"?2.6:bt==="round"||bt==="aviator"?1.5:2.2;for(let G of[-1,1]){let z=G*L;e.fillStyle=N?R(T,.72):bt==="aviator"?"rgba(120, 150, 170, 0.34)":"rgba(220, 238, 255, 0.11)",e.beginPath(),bt==="round"?e.arc(z,O,S*.86,0,Math.PI*2):bt==="cat_eye"?(e.moveTo(z-G*S*.9,O-b*.5),e.quadraticCurveTo(z,O-b*.86,z+G*S*1.12,O-b*1.02),e.quadraticCurveTo(z+G*S*1.02,O+b*.5,z+G*S*.3,O+b*.78),e.quadraticCurveTo(z-G*S*.86,O+b*.8,z-G*S*.9,O-b*.5),e.closePath()):bt==="aviator"?(e.moveTo(z-G*S*.88,O-b*.62),e.quadraticCurveTo(z,O-b*.9,z+G*S*.98,O-b*.6),e.quadraticCurveTo(z+G*S*1.04,O+b*.6,z+G*S*.2,O+b*1),e.quadraticCurveTo(z-G*S*.84,O+b*.86,z-G*S*.88,O-b*.62),e.closePath()):e.roundRect(z-S*.92,O-b*.82,S*1.84,b*1.64,bt==="bold"?4.5:6),e.fill(),e.stroke()}e.beginPath(),e.moveTo(-L+S*(bt==="round"?.84:.9),O-1.5),e.quadraticCurveTo(0,O-4.2,L-S*(bt==="round"?.84:.9),O-1.5),e.stroke()}}e.restore();let lt=l.hairStyle||"side_sweep";if(lt!=="none"){let T=["long_waves","sleek_bob","shoulder_lob","long_straight","braids"].includes(lt),O=lt==="quiff"||lt==="side_sweep"||lt==="pixie",S=lt==="quiff"?-1.38:lt==="pixie"?-1.18:-1.24,b=e.createLinearGradient(-26,-o.headH-24,26,-10);if(b.addColorStop(0,R(Fe(Q,de,.32))),b.addColorStop(.53,R(Q)),b.addColorStop(1,R(se(Q,.66))),e.fillStyle=b,e.save(),ye(),e.beginPath(),T){let N=lt==="sleek_bob"?36*o.headScale:lt==="long_straight"?31*o.headScale:24*o.headScale;e.moveTo(-o.headW-7,-8),e.bezierCurveTo(-o.headW-13,-o.headH-25,o.headW+13,-o.headH-25,o.headW+7,-8),e.quadraticCurveTo(o.headW+4,14,o.headW-.5,N),e.bezierCurveTo(o.headW-1,-o.headH*.67,o.headW*.38,-o.headH*.48,-o.headW*.14,-o.headH*.84),e.bezierCurveTo(-o.headW*.28,-o.headH*.58,-o.headW*.91,-o.headH*.6,-o.headW+.5,N),e.quadraticCurveTo(-o.headW-4,14,-o.headW-7,-8)}else if(O)e.save(),e.scale(o.headW,o.headH),e.moveTo(-1.02,.08),e.bezierCurveTo(-1.18,-.62,-.85,S,-.23,S),e.bezierCurveTo(.46,S-.04,1.18,-.88,1.04,-.08),e.lineTo(.96,.12),e.quadraticCurveTo(.94,-.13,.76,-.37),e.quadraticCurveTo(.82,-.23,.79,-.18),e.bezierCurveTo(.62,-.46,.11,-.67,-.24,-.72),e.quadraticCurveTo(-.43,-.7,-.68,-.54),e.quadraticCurveTo(-.87,-.41,-.94,.06),e.restore();else if(lt==="curly_halo"||lt==="afro"){let N=lt==="afro"?1.7:1;e.moveTo(-o.headW-11*N,-6),e.bezierCurveTo(-o.headW-22*N,-o.headH-28*N,o.headW+22*N,-o.headH-28*N,o.headW+11*N,-6),e.quadraticCurveTo(o.headW-4,-36*o.headScale,18,-44*o.headScale),e.quadraticCurveTo(0,-39*o.headScale,-18,-44*o.headScale),e.quadraticCurveTo(-o.headW+4,-36*o.headScale,-o.headW-11*N,-6)}else if(lt==="buzz")e.fillStyle=R(Q,.72),e.moveTo(-o.headW-1.5,-12),e.bezierCurveTo(-o.headW-4,-o.headH-8,o.headW+4,-o.headH-8,o.headW+1.5,-12),e.quadraticCurveTo(o.headW-5,-42*o.headScale,0,-46*o.headScale),e.quadraticCurveTo(-o.headW+5,-42*o.headScale,-o.headW-1.5,-12);else if(lt==="mohawk"){e.fillStyle=R(Q,.55),e.moveTo(-o.headW-1.5,-12),e.bezierCurveTo(-o.headW-4,-o.headH-8,o.headW+4,-o.headH-8,o.headW+1.5,-12),e.quadraticCurveTo(o.headW-5,-42*o.headScale,0,-46*o.headScale),e.quadraticCurveTo(-o.headW+5,-42*o.headScale,-o.headW-1.5,-12),e.closePath(),e.fill(),e.fillStyle=b;let N=o.headW*.3,G=-o.headH-31;e.beginPath(),e.moveTo(-N,-43*o.headScale),e.bezierCurveTo(-N-5,-o.headH-6,-N-1,G+8,-N*.45,G),e.quadraticCurveTo(1,G-6,N*.6,G+3),e.bezierCurveTo(N+4,G+10,N+5,-o.headH-6,N,-43*o.headScale),e.quadraticCurveTo(0,-49*o.headScale,-N,-43*o.headScale)}else e.moveTo(-o.headW-5,-10),e.bezierCurveTo(-o.headW-10,-o.headH-15,-20,-o.headH-22,6,-o.headH-19),e.bezierCurveTo(32,-o.headH-16,o.headW+10,-o.headH-10,o.headW+5,-10),e.lineTo(o.headW,5),e.lineTo(o.headW-4,5),e.quadraticCurveTo(o.headW-4.5,-24,o.headW-10,-38*o.headScale),e.bezierCurveTo(o.headW*.6,-o.headH*.67,o.headW*.46,-o.headH*.67,o.headW*.31,-o.headH*.82),e.quadraticCurveTo(o.headW*.05,-o.headH*.6,-o.headW*.55,-o.headH*.65),e.bezierCurveTo(-36,-45*o.headScale,-o.headW+6,-30,-o.headW+4,5),e.lineTo(-o.headW,5);if(e.closePath(),e.fill(),lt!=="buzz"&&lt!=="mohawk"){if(e.save(),e.clip(),e.scale(o.headW,o.headH),e.fillStyle=R(Fe(Q,de,.4),.72),ge){e.fillStyle=R(Fe(Q,de,.29),.6);for(let[N,G,z]of[[-.84,-.6,-.8],[-.65,-.91,-.45],[-.36,-1.02,-.29],[.16,-1.02,.22],[.46,-.88,.52],[.76,-.75,.8]])e.save(),e.translate(N,G),e.rotate(z),e.beginPath(),e.moveTo(-.15,.04),e.bezierCurveTo(-.12,-.06,.04,-.13,.15,-.025),e.bezierCurveTo(.06,-.06,-.005,-.055,-.15,.04),e.fill(),e.restore()}else if(O)for(let[N,G]of[[-.92,-.24],[-.69,-.54],[.36,-.52],[.76,-.36],[.99,-.12]]){let z=-.38+N*.08;e.beginPath(),e.moveTo(z,S+.09),e.bezierCurveTo(z+N*.26,S+.37,N*.8,G-.24,N,G),e.bezierCurveTo(N*.72,G-.28,z+N*.16,S+.48,z,S+.09),e.fill()}else{let N=T?-.14:.31,G=T?-1.09:-1.25;for(let z of[-1,1])e.beginPath(),e.moveTo(N,G+.06),e.bezierCurveTo(N+z*.36,G-.06,z*1.01,-.86,z*1.02,-.19),e.bezierCurveTo(z*.91,-.85,N+z*.35,G+.09,N,G+.06),e.fill(),e.beginPath(),e.moveTo(N,G+.13),e.bezierCurveTo(N+z*.19,G+.26,z*.83,-.83,z*.96,-.43),e.bezierCurveTo(z*.72,-.76,N+z*.16,G+.31,N,G+.13),e.fill()}e.restore()}if(l.fringe&&lt!=="buzz"&&lt!=="mohawk"){let N=-o.headH*.82,G=-35*o.headScale,z=o.headW-3;e.beginPath(),e.moveTo(-z-2,N+10),e.quadraticCurveTo(0,N-6,z+2,N+10),e.lineTo(z,G+1);for(let pe=5;pe>=-5;pe--)e.lineTo(pe/5*z,G+(pe%2?2.2:0)+Math.abs(pe)*.35);e.closePath(),e.fill()}e.restore()}if(ue!=="none"){let T=Je(l.headwearColor,[180,69,47]),O=-o.headH*.56,S=o.headW+(ue==="headband"?5.5:7.5);if(ue==="headband")e.strokeStyle=R(T),e.lineWidth=6.5*o.headScale,e.lineCap="round",e.beginPath(),e.moveTo(-S+1,O+8),e.quadraticCurveTo(0,O-15,S-1,O+8),e.stroke(),e.strokeStyle="rgba(255, 255, 255, 0.22)",e.lineWidth=1.4,e.beginPath(),e.moveTo(-S+5,O+4),e.quadraticCurveTo(0,O-17.5,S-5,O+4),e.stroke();else if(ue==="beret"){let b=e.createLinearGradient(-S,-o.headH-26,S,O+8);b.addColorStop(0,R(se(T,1.18))),b.addColorStop(1,R(se(T,.72))),e.fillStyle=b,e.beginPath(),e.moveTo(-S+1,O+6),e.bezierCurveTo(-S-20,O-12,-o.headW*.9,-o.headH-30,-4,-o.headH-24),e.bezierCurveTo(o.headW*.9,-o.headH-19,S+9,O-12,S-1,O+6),e.quadraticCurveTo(0,O-6,-S+1,O+6),e.closePath(),e.fill(),e.fillStyle=R(se(T,.66)),e.beginPath(),e.moveTo(-S+1,O+6),e.quadraticCurveTo(0,O-6,S-1,O+6),e.quadraticCurveTo(0,O-1.5,-S+1,O+6),e.fill(),e.strokeStyle=R(se(T,.7)),e.lineWidth=2.2,e.lineCap="round",e.beginPath(),e.moveTo(-7,-o.headH-25),e.lineTo(-9.5,-o.headH-30.5),e.stroke()}else if(ue==="headphones"){e.strokeStyle=R(se(T,.9)),e.lineWidth=5.2*o.headScale,e.lineCap="round",e.beginPath(),e.moveTo(-o.headW-5,-8),e.bezierCurveTo(-o.headW-9,-o.headH-22,o.headW+9,-o.headH-22,o.headW+5,-8),e.stroke();for(let b of[-1,1]){let N=b*(o.headW+3.5)-ae*.42,G=e.createLinearGradient(N-7,-18,N+7,14);G.addColorStop(0,R(se(T,1.2))),G.addColorStop(1,R(se(T,.68))),e.fillStyle=G,e.beginPath(),e.roundRect(N-7.5,-18,15,33,7),e.fill(),e.fillStyle="rgba(15, 23, 42, 0.5)",e.beginPath(),e.roundRect(N-b*6.5-2,-14,4,25,2),e.fill()}}else if(ue==="bow"){e.save(),e.translate(o.headW*.5,-o.headH-7),e.rotate(.3);for(let b of[-1,1]){let N=e.createLinearGradient(0,-10,b*18,10);N.addColorStop(0,R(se(T,.8))),N.addColorStop(1,R(se(T,1.16))),e.fillStyle=N,e.beginPath(),e.moveTo(0,0),e.bezierCurveTo(b*6,-13,b*20,-12,b*18,0),e.bezierCurveTo(b*20,12,b*6,13,0,0),e.fill()}e.fillStyle=R(se(T,.68)),e.beginPath(),e.roundRect(-3.8,-4.8,7.6,9.6,2.6),e.fill(),e.restore()}else if(ue==="flower"){let b=-o.headW*.86,N=-o.headH*.5;e.fillStyle=R(T),e.strokeStyle=R(se(T,.7),.7),e.lineWidth=.7;for(let G=0;G<5;G++){let z=G/5*Math.PI*2-Math.PI/2;e.beginPath(),e.ellipse(b+Math.cos(z)*6.4,N+Math.sin(z)*6.4,5.4,3.7,z,0,Math.PI*2),e.fill(),e.stroke()}e.fillStyle="#f2c94c",e.beginPath(),e.arc(b,N,3.2,0,Math.PI*2),e.fill()}else if(ue==="tiara"){let b=-o.headH*.93,N=o.headW*.64;e.fillStyle=R(T),e.strokeStyle=R(se(T,.66),.85),e.lineWidth=.8,e.beginPath(),e.moveTo(-N,b+5),e.quadraticCurveTo(0,b-4,N,b+5),e.lineTo(N-1,b+9),e.quadraticCurveTo(0,b,-N+1,b+9),e.closePath(),e.fill(),e.stroke();for(let[G,z]of[[-N*.5,7.5],[0,12.5],[N*.5,7.5]]){let pe=G===0?b+.5:b+1.6;e.beginPath(),e.moveTo(G-4.6,pe+1.6),e.lineTo(G,pe-z),e.lineTo(G+4.6,pe+1.6),e.closePath(),e.fill(),e.stroke()}e.fillStyle=R(A),e.beginPath(),e.arc(0,b-5.4,2.5,0,Math.PI*2),e.fill(),e.fillStyle="rgba(255, 255, 255, 0.75)",e.beginPath(),e.arc(-.8,b-6.2,.8,0,Math.PI*2),e.fill()}else if(ue==="fedora"){let b=O+5,N=o.headW+25,G=-o.headH-31,z=e.createLinearGradient(-S,G,S,b);z.addColorStop(0,R(se(T,1.18))),z.addColorStop(1,R(se(T,.74))),e.fillStyle=z,e.beginPath(),e.moveTo(-S+2,b),e.bezierCurveTo(-S-2,G+14,-o.headW*.62,G,-8,G+3),e.quadraticCurveTo(0,G+9,8,G+3),e.bezierCurveTo(o.headW*.62,G,S+2,G+14,S-2,b),e.closePath(),e.fill(),e.fillStyle=R(se(T,.48)),e.beginPath(),e.moveTo(-S+1,b-10),e.quadraticCurveTo(0,b-18,S-1,b-10),e.lineTo(S-2,b),e.quadraticCurveTo(0,b-9,-S+2,b),e.closePath(),e.fill();let pe=e.createLinearGradient(0,b-10,0,b+6);pe.addColorStop(0,R(se(T,1.06))),pe.addColorStop(1,R(se(T,.6))),e.fillStyle=pe,e.beginPath(),e.moveTo(-N,b+4),e.quadraticCurveTo(0,b-15,N,b+4),e.quadraticCurveTo(0,b-2,-N,b+4),e.closePath(),e.fill()}else if(ue==="chef"){let b=O-17,N=-o.headH-46,G=e.createLinearGradient(-S,N,S,O+6);G.addColorStop(0,R(se(T,1.08))),G.addColorStop(1,R(se(T,.84))),e.fillStyle=G,e.beginPath(),e.moveTo(-S+2,b+2),e.bezierCurveTo(-S-22,b-6,-S-14,N+6,-o.headW*.42,N+6),e.bezierCurveTo(-o.headW*.3,N-8,o.headW*.3,N-8,o.headW*.42,N+6),e.bezierCurveTo(S+14,N+6,S+22,b-6,S-2,b+2),e.closePath(),e.fill(),e.strokeStyle=R(se(T,.66),.55),e.lineWidth=1;for(let z of[-.5,0,.5])e.beginPath(),e.moveTo(z*S,b-5+Math.abs(z)*4),e.quadraticCurveTo(z*S*1.25,N+26,z*S*1.05,N+14),e.stroke();e.fillStyle=R(se(T,.93)),e.beginPath(),e.moveTo(-S+1,O+6),e.lineTo(-S+2,b),e.quadraticCurveTo(0,b-9,S-2,b),e.lineTo(S-1,O+6),e.quadraticCurveTo(0,O-5,-S+1,O+6),e.closePath(),e.fill(),e.stroke()}else if(ue==="headscarf"){let b=-o.headH*.64,N=-o.headH*1.36-10,G=ve+1,z=o.cheekW*.93,pe=e.createLinearGradient(-S,-o.headH-12,S,G+16);pe.addColorStop(0,R(se(T,1.16))),pe.addColorStop(.6,R(T)),pe.addColorStop(1,R(se(T,.74))),e.fillStyle=pe,e.beginPath(),e.moveTo(-o.headW-8,4),e.bezierCurveTo(-o.headW-13,N,o.headW+13,N,o.headW+8,4),e.bezierCurveTo(o.headW+9,34,o.jawW+12,G+6,o.neckHalfW+15,G+20),e.lineTo(-o.neckHalfW-15,G+20),e.bezierCurveTo(-o.jawW-12,G+6,-o.headW-9,34,-o.headW-8,4),e.closePath(),e.moveTo(0,b),e.bezierCurveTo(-z*1.02,b,-z*1.04,G-14,0,G),e.bezierCurveTo(z*1.04,G-14,z*1.02,b,0,b),e.closePath(),e.fill("evenodd"),e.strokeStyle=R(se(T,.66),.6),e.lineWidth=1.1,e.beginPath(),e.moveTo(-o.headW*.5,-o.headH*.93),e.quadraticCurveTo(-o.headW-1,-o.headH*.5,-o.headW-2,14),e.moveTo(o.headW*.5,-o.headH*.93),e.quadraticCurveTo(o.headW+1,-o.headH*.5,o.headW+2,14),e.stroke()}else{let b=ue==="cap",N=-o.headH-(b?17:23),G=e.createLinearGradient(-S,N,S,O+10);if(G.addColorStop(0,R(se(T,1.2))),G.addColorStop(.6,R(T)),G.addColorStop(1,R(se(T,.7))),e.fillStyle=G,e.beginPath(),e.moveTo(-S,O+6),e.bezierCurveTo(-S-5,N+6,-o.headW*.5,N,0,N),e.bezierCurveTo(o.headW*.5,N,S+5,N+6,S,O+6),e.quadraticCurveTo(0,O-5,-S,O+6),e.closePath(),e.fill(),b){e.strokeStyle=R(se(T,.7),.55),e.lineWidth=1.1;for(let pe of[-.52,0,.52])e.beginPath(),e.moveTo(0,N+1),e.quadraticCurveTo(pe*S*1.25,N+12,pe*S,O+2-(1-pe*pe)*6),e.stroke();e.fillStyle=R(se(T,.78)),e.beginPath(),e.arc(0,N+1.2,2.8,0,Math.PI*2),e.fill();let z=e.createLinearGradient(0,O-4,0,O+17);z.addColorStop(0,R(se(T,.74))),z.addColorStop(1,R(se(T,.5))),e.fillStyle=z,e.beginPath(),e.moveTo(-S+.5,O+6),e.quadraticCurveTo(0,O-5,S-.5,O+6),e.bezierCurveTo(S+4,O+15,o.headW*.6,O+18,0,O+15),e.bezierCurveTo(-o.headW*.6,O+18,-S-4,O+15,-S+.5,O+6),e.closePath(),e.fill()}else{let z=12*o.headScale;e.fillStyle=R(se(T,.84)),e.beginPath(),e.moveTo(-S-1.5,O+7),e.quadraticCurveTo(0,O-5,S+1.5,O+7),e.lineTo(S+1.5,O+7-z),e.quadraticCurveTo(0,O-5-z,-S-1.5,O+7-z),e.closePath(),e.fill(),e.strokeStyle=R(se(T,.62),.7),e.lineWidth=1.1;for(let pe=-6;pe<=6;pe++){let Ce=pe/6.5*S,xe=(1-(Ce/S)**2)*12;e.beginPath(),e.moveTo(Ce,O+7-xe-.5),e.lineTo(Ce,O+7-xe-z+.5),e.stroke()}}}}if(l.headsetMic){let T=o.headW-.5-ae*.42;e.strokeStyle="#1e293b",e.lineWidth=2.2,e.lineCap="round",e.beginPath(),e.moveTo(T+2,-2),e.quadraticCurveTo(T-2,29*o.headScale+ce*.25,22*o.headScale+ae*.5,34*o.headScale+ce*.3),e.stroke(),e.fillStyle="#0f172a",e.beginPath(),e.ellipse(T+2.5,-2,4.2,8.5,0,0,Math.PI*2),e.fill();let O=21*o.headScale+ae*.5,S=34*o.headScale+ce*.3;e.fillStyle="#1e293b",e.beginPath(),e.ellipse(O,S,4.2,2.8,-.15,0,Math.PI*2),e.fill(),n.energy>.06&&(e.fillStyle=R(A,Math.min(.95,.35+n.energy*.8)),e.beginPath(),e.arc(O-1.5,S,1.5,0,Math.PI*2),e.fill())}if(i.showVoiceWaves&&n.energy>.08)for(let T=0;T<2;T++){let O=(n.wavePhase+T*.5)%1,S=30*o.headScale+O*24,b=(1-O)*Math.min(.42,n.energy*.48);e.strokeStyle=R(A,b),e.lineWidth=1.5,e.beginPath(),e.arc(ae*.65,31*o.headScale+ce*.3,S,-.42,.42),e.stroke(),e.beginPath(),e.arc(ae*.65,31*o.headScale+ce*.3,S,Math.PI-.42,Math.PI+.42),e.stroke()}if(e.restore(),e.restore(),i.showSculptHandles){let T=gi(t,a,l),O=i.activeSculptId||"",S=i.hoverSculptId||"",b=Math.max(1,Math.min(t,a)/340);e.save();for(let N of T){let G=N.id===O||N.id===S,z=(G?9.5:7)*b;if(N.mirrorX!==void 0&&(e.save(),e.setLineDash([3*b,4*b]),e.strokeStyle=G?"rgba(56, 189, 248, 0.55)":"rgba(255, 255, 255, 0.16)",e.lineWidth=1.1*b,e.beginPath(),e.moveTo(N.mirrorX,N.y),e.lineTo(N.x,N.y),e.stroke(),e.restore(),e.beginPath(),e.arc(N.mirrorX,N.y,z*.85,0,Math.PI*2),e.fillStyle=G?"#38bdf8":"rgba(15, 23, 42, 0.72)",e.fill(),e.strokeStyle="#ffffff",e.lineWidth=1.7*b,e.stroke()),e.beginPath(),e.arc(N.x,N.y,z+4.5*b,0,Math.PI*2),e.fillStyle=G?"rgba(56, 189, 248, 0.28)":"rgba(56, 189, 248, 0.14)",e.fill(),e.beginPath(),e.arc(N.x,N.y,z,0,Math.PI*2),e.fillStyle=G?"#38bdf8":"#0ea5e9",e.fill(),e.strokeStyle="#ffffff",e.lineWidth=2*b,e.stroke(),G){e.font=`600 ${Math.round(11.5*b)}px system-ui, -apple-system, sans-serif`;let pe=e.measureText(N.label).width+16*b,Ce=22*b,xe=le(N.x-pe*.5,6*b,t-pe-6*b),tt=N.y>44*b?N.y-32*b:N.y+16*b;e.fillStyle="rgba(15, 23, 42, 0.92)",e.beginPath(),e.roundRect(xe,tt,pe,Ce,6*b),e.fill(),e.strokeStyle="rgba(56, 189, 248, 0.65)",e.lineWidth=1*b,e.stroke(),e.fillStyle="#f8fafc",e.fillText(N.label,xe+8*b,tt+Ce*.68)}}e.restore()}}var No=2*Math.PI,dn=([e,t,a])=>{let s=Math.hypot(e,t,a)||1;return[e/s,t/s,a/s]},mn=([e,t,a],[s,n,r])=>[t*r-a*n,a*s-e*r,e*n-t*s],fn=(e,t)=>e.map((a,s)=>a-t[s]),Ct=e=>Number.parseInt(e.slice(1),16);function qt(e,t,a){let s=e>>16,n=e>>8&255,r=e&255;return Math.round(s+((t>>16)-s)*a)<<16|Math.round(n+((t>>8&255)-n)*a)<<8|Math.round(r+((t&255)-r)*a)}function _(e,t,a){return"#"+qt(Ct(e),Ct(t),a).toString(16).padStart(6,"0")}function gn(e,t,a=!1){let s=[];for(let n=0;n<e-1;n++)for(let r=0;r<t;r++){let i=n*t+r,l=n*t+(r+1)%t,p=i+t,h=l+t;s.push(...a?[[i,p,l],[l,p,h]]:[[i,l,p],[l,h,p]])}return s}function Ms(e,t,a,s){let n=e.length,r=n+a;e.push(...e.slice(0,a),...e.slice(-a));for(let i=1;i<a-1;i++)s?t.push([n,n+i,n+i+1],[r,r+i+1,r+i]):t.push([n,n+i+1,n+i],[r,r+i,r+i+1])}var _a=class{constructor(){Ga(this,"data",[]);Ga(this,"indices",[]);Ga(this,"parts",[]);Ga(this,"finish",0);Ga(this,"scale",1)}markPart(t){this.parts.push({start:this.data.length/10,name:t})}mesh(t,a,s,n=t,r=null){let i=t.map(()=>[0,0,0]);for(let[h,c,o]of a){let d=mn(fn(n[c],n[h]),fn(n[o],n[h]));for(let u of[h,c,o])for(let m=0;m<3;m++)i[u][m]+=d[m]}let l=typeof s=="string"?Ct(s):null,p=this.data.length/10;for(let h=0;h<t.length;h++){let[c,o,d]=t[h],u=l??s[h],m=(u>>16)/255,g=(u>>8&255)/255,f=(u&255)/255,E=r?r[h]:0;this.data.push(c*this.scale,o*this.scale,d*this.scale,...dn(i[h]),m*(1-.62*E),g*(1-E),f*(1-.86*E),this.finish)}for(let[h,c,o]of a)this.indices.push(p+h,p+c,p+o)}ellipsoid(t,a,s,{rotation:n=[0,0,0],sides:r=20,rings:i=12}={}){let l=[],[p,h,c]=t,[o,d,u]=a,[m,g,f]=n.map(Math.sin),[E,y,w]=n.map(Math.cos);for(let k=0;k<=i;k++){let Y=Math.PI*(k/i-.5);for(let C=0;C<r;C++){let q=No*C/r,Q=o*Math.cos(Y)*Math.sin(q),de=d*Math.sin(Y),D=u*Math.cos(Y)*Math.cos(q),M=de*E-D*m,A=de*m+D*E,I=Q*y+A*g;l.push([p+I*w-M*f,h+I*f+M*w,c+A*y-Q*g])}}this.mesh(l,gn(i+1,r),s)}loft(t,a,{sides:s=28,pleat:n=0}={}){let r=[];for(let[p,h,c,o=0,d=0]of t)for(let u=0;u<s;u++){let m=u*No/s,g=1+n*Math.cos(12*m);r.push([d+h*Math.sin(m)*g,p,o+c*Math.cos(m)*g])}let i=t[1][0]<t[0][0],l=gn(t.length,s,i);Ms(r,l,s,i),this.mesh(r,l,a)}tube(t,a,s,{sides:n=10}={}){let r=[];for(let l=0;l<t.length;l++){let p=dn(fn(t[Math.min(t.length-1,l+1)],t[Math.max(0,l-1)])),h=dn(mn(p,Math.abs(p[2])<.94?[0,0,1]:[0,1,0])),c=mn(h,p),o=Array.isArray(a)?a[l]:a,[d,u]=Array.isArray(o)?o:[o,o];for(let m=0;m<n;m++){let g=Math.cos(No*m/n)*d,f=Math.sin(No*m/n)*u;r.push(t[l].map((E,y)=>E+g*h[y]+f*c[y]))}}let i=gn(t.length,n,!0);Ms(r,i,n,!0),this.mesh(r,i,s)}};var Mt=Math.PI,rt=(e,t,a)=>e+(t-e)*a,Ws=e=>Math.max(0,Math.min(1,e)),Rs=e=>(e=Ws(e),e*e*(3-2*e));function gt(e,t,a,s,n,r){let i=[],l=[];for(let p=0;p<=s;p++)for(let h=0;h<=a;h++)if(i.push(n(h/a,p/s)),p&&h){let c=p*(a+1)+h,o=c-a-1,d=o-1,u=c-1;t>0?l.push([d,u,o],[o,u,c]):l.push([d,o,u],[o,c,u])}e.mesh(i,l,r)}var wa=(e,t)=>Array.from({length:e+1},(a,s)=>t(s/e));function ks(e,t,a,s,n,r,i,l,p){let h=t==="court_high_tops",c=t==="slingback_pumps",o=t==="brogue_oxfords";if(!h&&!c&&!o)return!1;let{shoeColor:d,shoeTrim:u,shoeSole:m}=a,g=_(d,"#2e2331",.36),f=_(m,u,.42),E=h?.188:c?.164:.18,y=h?.7:c?.73:.65,w=h?-.187:-.167,k=w+y,Y=c?.245:o?.063:0,C=h?.091:c?.028:.047,q=(v,P,X)=>[n*(r+v+.08*X),i+l*P,X],Q=v=>Y*(1-Rs((v-.16)/.48)),de=v=>rt(w,k,v),D=v=>{let P=Math.max(.007,Math.sin(Mt*Ws(v)))**(c?.66:.42),X=1-.12*Math.exp(-(((v-.43)/.14)**2))+.15*Math.exp(-(((v-.72)/.17)**2));return E*P*X*(c?1-.64*Rs((v-.63)/.37):1)},M=(v,P,X,oe=0)=>q(v*(D(P)+oe),Q(P)+X,de(P)),A=v=>(.068+.094*(1-v)+.105*Math.exp(-(((v-.41)/.22)**2)))*(.25+.75*Math.max(0,Math.sin(Mt*v))**.24),I=(v,P,X=0)=>q((1+X)*v*D(P),Q(P)+C+.029+A(P)*Math.sqrt(Math.max(0,1-v*v))+.54*X,de(P)),H=(v,P,X=0)=>{let oe=2*Mt*v;return M(Math.sign(Math.sin(oe)),(1+Math.cos(oe))/2,P,X)};gt(e,n,64,2,(v,P)=>H(v,rt(.009,C,P),.004*Math.sin(Mt*P)),m),gt(e,-n,12,36,(v,P)=>M(2*v-1,P,.009),m),e.tube(wa(72,v=>H(v,C-.006,.003)),h?.009:.006,f,{sides:7});let W=w+.065;if(Y){let v=c?.029:.107,P=c?.034:.085,X=(oe,$)=>q((v+$*(c?.038:.009))*Math.sin(oe),rt(.009,Y+C,$),W+$*(c?.026:0)+(P+.014*$)*Math.cos(oe));gt(e,n,30,5,(oe,$)=>X(2*Mt*oe,$),m),gt(e,-n,28,1,(oe,$)=>q(v*$*Math.sin(2*Mt*oe),.009,W+P*$*Math.cos(2*Mt*oe)),m),o&&e.tube(wa(32,oe=>X(2*Mt*oe,.45)),.006,f,{sides:6})}gt(e,n,64,2,(v,P)=>H(v,C+.03*P),c?u:d),c&&!s?gt(e,n,20,32,(v,P)=>M((2*v-1)*.99,P,C+.031),_(d,u,.35)):gt(e,n,28,42,(v,P)=>I(2*v-1,P),c?s:d);let V=(v,P,X,oe,$,ae)=>e.tube(wa(14,ue=>I(rt(X,oe,ue),rt(v,P,ue),.014+.006*Math.sin(Mt*ue))),ae,$,{sides:7}),ee=(v,P,X,oe)=>e.ellipsoid(I(v,P,.014),[X,.55*X,X],oe,{sides:9,rings:5});if(c){let v=oe=>.605-.34*Math.abs(oe)**2;gt(e,n,30,25,(oe,$)=>{let ae=2*oe-1;return I(ae,rt(v(ae),1,$),.012)},d),e.tube(wa(38,oe=>{let $=2*oe-1;return I($,v($),.015)}),.009,u,{sides:7});let P=(oe,$=0)=>q(.137*Math.sin(oe),Y+.145+.037*Math.cos(oe)+$,.01-.159*Math.cos(oe));gt(e,n,40,2,(oe,$)=>P(rt(-2.16,2.16,oe),.027*$),d);let X=P(1.59,.014);e.ellipsoid(X,[.014,.028,.029],u,{sides:10,rings:8});for(let oe of[-1,1])gt(e,n,8,14,($,ae)=>{let ue=Math.sin(Mt*ae)**.65;return I(oe*(.045+.65*ae),.69+.038*ae+($-.5)*.145*ue,.044+.044*ue)},u);return e.ellipsoid(I(0,.695,.064),[.032,.027,.023],u,{sides:14,rings:7}),!0}if(h){let P=(oe,$,ae=0)=>{let ue=2*Mt*oe,Ae=(1+Math.cos(ue))*.5,we=rt(.175,.58-.06*Ae,$),ye=p(3.58-we),Oe=rt(.157,ye.rx+.033,$),ce=rt(.185,ye.rz+.033,$);return q(ye.x-r+(Oe+ae)*Math.sin(ue),we,ye.z+.018*(1-$)+(ce+ae)*Math.cos(ue))};gt(e,n,48,12,(oe,$)=>P(oe,$),d),gt(e,n,48,4,(oe,$)=>P(oe,rt(.73,.96,$),.006),_(d,u,.3)),e.tube(wa(54,oe=>P(oe,1,.005)),.019,u,{sides:9}),gt(e,n,25,15,(oe,$)=>I(2*oe-1,rt(.77-.043*(2*oe-1)**2,1,$),.012),u);for(let oe of[-1,1])gt(e,n,22,3,($,ae)=>{let ue=rt(.21,.73,$),Ae=rt(.9,.65+.15*Math.cos($*Mt),ae);return I(oe*Ae,ue,.02)},_(u,d,.26));let X=(oe,$)=>q(oe*.065,.22+.315*$,.238-.105*$);gt(e,n,9,13,(oe,$)=>X(2*oe-1,$),g);for(let oe=0;oe<4;oe++){let $=.06+.22*oe;for(let ae of[-1,1])e.tube(wa(9,ue=>{let Ae=X(ae*rt(-1,1,ue),$+.17*ue);return Ae[2]+=.012+.013*Math.sin(Mt*ue),Ae}),.01,u,{sides:7})}}else{let v=P=>.62+.12*Math.exp(-((P/.28)**2))-.19*Math.abs(P)**2;gt(e,n,30,22,(P,X)=>{let oe=2*P-1;return I(oe,rt(v(oe),1,X),.012)},_(d,u,.24)),e.tube(wa(30,P=>{let X=2*P-1;return I(X,v(X),.023)}),.005,g,{sides:6});for(let P=0;P<17;P++){let X=rt(-.92,.92,P/16);ee(X,v(X)+.027,.0085,g)}for(let P of[-1,1]){gt(e,n,6,18,(X,oe)=>I(P*rt(.25,.9,X),rt(.16,.57-.07*X,oe),.013),d);for(let X of[.33,.4,.47])ee(P*.31,X,.014,g),V(X,X+.033,P*.29,-P*.29,u,.008)}for(let[P,X]of[[0,.85],[-.18,.82],[.18,.82],[-.34,.8],[.34,.8]])ee(P,X,.009,g)}return!0}var yi=Math.PI*2,Rt=(e,t,a)=>e+(t-e)*a;function nt(e,t,a,{flip:s=!1,capTop:n=!1,capBottom:r=!1,pleats:i=0}={}){let l=t[0].length,p=[],h=[];for(let d=1;d<t.length;d++)for(let u=0;u<l;u++){let m=(d-1)*l+u,g=(d-1)*l+(u+1)%l,f=m+l,E=g+l,y=u*i/l%1;(i&&y>=.26&&y<.43?h:p).push([m,f,g],[g,f,E])}let c=(d,u,m,g)=>{if(g)for(let f of u)[f[1],f[2]]=[f[2],f[1]];e.mesh(d,u,m)},o=t.flat();c(o,p,a,s),h.length&&c(o,h,_(a,"#55344b",.19),s);for(let[d,u,m]of[[n,t[0],s],[r,t.at(-1),!s]]){if(!d)continue;let g=[0,1,2].map(E=>u.reduce((y,w)=>y+w[E],0)/l),f=[];for(let E=0;E<l;E++)f.push([l,E,(E+1)%l]);c([...u,g],f,_(a,"#3c2f40",.12),m)}}function ua(e,t){return Array.from({length:e},(a,s)=>t(s*yi/e))}function En(e,t){let a=e.thighWidth??1,s=e.calfWidth??1,n=.87+.13*t/.84,r=[[-.2,.35*a,.34*a,-.01],[.15,.362*a,.355*a,-.013],[.52,.337*a,.327*a,.001],[.94,.28*a,.276*a,.025],[1.26,.233*a,.227*a,.036],[1.47,.185*a,.189*a,.041],[1.62,.176,.179,.055],[1.76,.165,.158,.041],[1.95,.179*s,.178*s,.001],[2.19,.213*s,.218*s,-.045],[2.39,.221*s,.226*s,-.058],[2.65,.197*s,.197*s,-.062],[2.91,.15*s,.161*s,-.033],[3.15,.11*s,.128*s,-.014],[3.31,.106*s,.12*s,-.002],[3.48,.116*s,.13*s,.01]];return i=>{let l=0;for(;l<r.length-2&&i>r[l+1][0];)l++;let p=r[Math.max(0,l-1)],h=r[l],c=r[l+1],o=r[Math.min(r.length-1,l+2)],d=c[0]-h[0],u=Math.max(0,Math.min(1,(i-h[0])/d)),m=u*u,g=m*u,f=[1,2,3].map(y=>(2*g-3*m+1)*h[y]+(g-2*m+u)*d*(c[y]-p[y])/(c[0]-p[0])+(3*m-2*g)*c[y]+(g-m)*d*(o[y]-h[y])/(o[0]-h[0])),E=f[0]*n;return{x:Math.max(t*(.48+.039*i),E+.01),rx:E,rz:f[1]*n,z:f[2]}}}function Na(e,t,a=.12){let s=Math.max(1,Math.ceil((t-e)/a));return Array.from({length:s+1},(n,r)=>Rt(e,t,r/s))}function Ai(e,t,a,s,n,r=0){let{x:i,rx:l,rz:p,z:h}=e(n);return ua(32,c=>[s*(i+(l+r)*Math.sin(c)),t-n*a,h+(p+r)*Math.cos(c)])}function Ti(e,t,a,s,n,r,i,l,p){if(t==="barefoot"){e.ellipsoid([n*r,i+.115*l,.082],[.136,.115*l,.29],s,{rotation:[0,n*.07,0],sides:24,rings:12});return}let h=a.shoeColor||"#3f3240",c=a.shoeTrim||_(h,"#fff8f4",.4),o=a.shoeSole||_(h,"#1e1525",.45);if(ks(e,t,{shoeColor:h,shoeTrim:c,shoeSole:o},s,n,r,i,l,p))return;let d=["ankle","heels","knee_boots"].includes(t),u=t==="strappy"||t==="heels",m=u?.18:d?.075:0,g=t==="sneakers"||t==="mary_janes"?.064:.037,f=u?.65:t==="slippers"?.61:.59,E=t==="slippers"||t==="sneakers"?.19:.165,y=(M,A,I)=>[n*(r+M+.08*I),i+A*l,I],w=(M,A)=>{let I=Math.cos(M),H=1+.12*I;return[E*H*Math.sin(M)*A,.115+I*f*.5*A]},k=M=>m*Math.max(0,Math.min(1,(.23-M)/.29)),Y=(M,A)=>ua(36,I=>{let[H,W]=w(I,M);return y(H,k(W)+A(I),W)}),C=Y(1,()=>g),q=Y(.98,()=>.009);if(nt(e,[C,q],o,{flip:n<0,capBottom:!0}),t!=="slippers"&&e.tube([...C,C[0]],.006,_(o,c,.43),{sides:6}),m){let M=t==="strappy"?.035:.074;e.tube([y(0,.013,-.124),y(0,m+.02,-.108)],[[M,M*.88],[M*1.2,M]],o,{sides:16})}let Q=(M,A)=>Y(M,I=>g+A+.018*Math.cos(I)),de=["strappy","flats","mary_janes","slippers"].includes(t);if(de&&!s)nt(e,[Q(.95,.025),C],_(h,c,.32),{flip:n<0,capTop:!0});else if(de){let M=y(0,g+.097+m*.67,.074);e.ellipsoid(M,[E*.84,(.12+m*.3)*l,.236],s,{rotation:[.17+m*.8,n*.07,0],sides:26,rings:12})}if(t!=="strappy"){let M=ua(36,A=>{let[,I]=w(A,1),H=(1+Math.cos(A))/2,V=de||t==="loafers"?.059+.075*H**2:.13+.14*(1-H),ee=t==="slippers"?.9:.85,[v]=w(A,ee);return y(v,k(I)+g+V,.014+(I-.014)*ee)});if(nt(e,[M,Q(.995,.027),C],h,{flip:n<0}),d||t==="sneakers"||t==="loafers"||t==="slippers"){let A=Q(.45,d||t==="sneakers"?.185:.122);nt(e,[A,M],h,{flip:n<0}),e.ellipsoid(y(0,g+.12+m*.33,.11),[E*.71,.08*l,.2],h,{sides:20,rings:9})}else e.ellipsoid(y(0,g+.071,.255),[E*.9,.085*l,.152],h,{sides:22,rings:10}),e.tube([...M,M[0]],.009,c,{sides:6})}let D=(M,A,I,H=.101,W=0)=>{let V=Na(0,1,.08).map(ee=>y((ee-.5)*E*1.8,g+.08+k(M)+H*Math.sin(Math.PI*ee),M+(ee-.5)*W));e.tube(V,A,I,{sides:8})};if(d){let M=t==="knee_boots"?1.59:t==="heels"?.85:.64,A=Math.ceil((M-.15)/.09),I=ee=>{let v=p(3.58-ee);return ua(32,P=>y(v.x-r+(v.rx+.024)*Math.sin(P),ee,v.z+(v.rz+.033)*Math.cos(P)))},H=Array.from({length:A+1},(ee,v)=>I(Rt(M,.15,v/A)));nt(e,H,h,{flip:n<0,capTop:!0}),e.tube([...H[0],H[0][0]],.012,c,{sides:6});let W=I(.39);e.tube([...W,W[0]],.023,o,{sides:7});let V=W[8];e.ellipsoid(V,[.014,.038*l,.04],c,{sides:10,rings:6}),e.tube(H.map(ee=>ee[16]),.008,o,{sides:5})}else if(t==="sneakers"){for(let A of[.046,.104,.162])D(A,.011,c,.148,.052),D(A,.011,c,.149,-.052);let M=Na(-1,1,.12).map(A=>y(.095*A,.219-.047*A*A,-.126+.035*A*A));e.tube(M,.016,c,{sides:7})}else if(t==="mary_janes"||t==="loafers"){if(D(.092,t==="mary_janes"?.027:.022,t==="loafers"?c:h,.139),t==="mary_janes"){let M=[[0,.01],[.035,.01],[.035,.07],[0,.07],[0,.01]].map(([A,I])=>y(E*.88,.145+A,.052+I));e.tube(M,.009,c,{sides:7})}}else if(t==="strappy"){D(.245,.022,h);let M=ua(20,A=>y(.117*Math.sin(A),.36,.125*Math.cos(A)));e.tube([...M,M[0]],.02,c,{sides:7})}else if(t==="flats")for(let M of[-1,1])e.ellipsoid(y(M*.038,.178,.207),[.049,.023,.026],c,{rotation:[0,0,M*.35]});else t==="slippers"&&e.ellipsoid(y(0,.233,.203),[.087,.056,.078],c,{sides:14,rings:8})}function Ls(e){let t=[e[0]],a=(n,r)=>(e[n+1][r]-e[n][r])/(e[n][0]-e[n+1][0]),s=(n,r)=>{if(n===0)return a(0,r);if(n===e.length-1)return a(n-1,r);let i=a(n-1,r),l=a(n,r);return i*l>0?2*i*l/(i+l):0};for(let n=0;n<e.length-1;n++){let r=e[n],i=e[n+1],l=r[0]-i[0],p=Math.max(1,Math.ceil(l/.15));for(let h=1;h<=p;h++){let c=h/p,o=c*c,d=o*c,u=[Rt(r[0],i[0],c)];for(let m=1;m<r.length;m++)u.push((2*d-3*o+1)*r[m]+(d-2*o+c)*l*s(n,m)+(3*o-2*d)*i[m]+(d-o)*l*s(n+1,m));t.push(u)}}return t}function Ii(e,t,a,s,n,r,i,l,p,h,c,o){let d=t==="halter_gown",u=t==="one_shoulder_dress",m=d?3.29:2.11,g=p-m*h,f=[[...n,0,0],[...r,.002,0],[c(1.94),Rt(r[1],i,.68),Rt(r[2],l,.68),.004,0],[c(2.18),i,l,.008,0],[p,i*(d?1.015:1.08),l*1.07,.012,0],[p-.82*h,i*(d?.97:1.23),l*(d?1.01:1.33),.025,.06],[p-1.48*h,i*(d?.88:1.39),l*(d?.93:1.49),.039,.1]];d&&f.push([p-2.18*h,i*.91,l,.048,.17],[p-2.69*h,i*1.13,l*1.43,.07,.25]);let E=i*(d?1.58:1.54),y=l*(d?1.98:1.69),w=[g,E,y,d?.095:.073,d?.41:.18],k=[g+.038*h,E*.989,y*.989,w[3],w[4]],Y=d?8:10,C=([de,D,M,A,I],H,W=0)=>{let V=1+A*Math.cos(Y*H+I),ee=d?(A/w[3])**3*.078*(1-Math.cos(H))*h:0,v=Math.sin(H),P=Math.cos(H),X=u?(A/w[3])**2*(.18+.38*v+.17*P)*h:0;return o([(D*V+W)*v,de-ee+X,(M*V+W)*P],v,P)},q=Ls([...f.slice(1),k]),Q=[f[0],...q,w].map(de=>ua(96,D=>C(de,D)));if(nt(e,Q.slice(0,2),_(a,s,d?.1:.3)),nt(e,Q.slice(1,-1),a),nt(e,Q.slice(-2),_(a,s,d?.2:.45),{capBottom:!0}),u){let de=n[0]-g,D=q.map(M=>{let A=Math.max(0,(n[0]-M[0])/de);return C(M,-1.1+2.13*A**1.34,.015)});e.tube(D,.014,_(a,s,.5),{sides:8})}else if(!d)for(let de of[-.43,.43,Math.PI-.43,Math.PI+.43]){let D=q.map(M=>C(M,de,.006));e.tube(D,.006,_(a,"#483545",.26),{sides:6})}return u?m-.76:m}function vs(e,t,{hip:a,leg:s,floor:n,waist:r,hips:i,hipDepth:l,y:p,shapeContour:h,dress:c,finish:o},{garmentOnly:d=!1}={}){let u=t.wardrobe||{},m=u.bottom||"trousers",g=c?t.outfitPrimary:u.bottomColor||_(t.outfitPrimary,"#241c30",.42),f=c?t.outfitAccent:u.bottomAccent||t.outfitAccent,E=u.shoes||"loafers",y=u.legwear||"none",w=En(t,i),k=w(.1),Y=Math.max(i+.036,k.x+k.rx+.035),C=Math.max(l+.052,k.rz+.075),q=c||/skirt|tennis/.test(m),Q={briefs:.18,denim:.55,lounge_shorts:.58,biker_shorts:1.03,court_shorts:1.22}[m],de={knee_boots:1.59,heels:.85,ankle:.64,court_high_tops:.52}[E]||0,D=3.58-(de||.145),A=Q??(de?D:3.31),I=p(1.57),H=p(1.7),W=[I,r+.045,.385],V=[H,r+.075,.407],ee=$=>t.waistDefinition||t.hipCurve||t.bellyFullness?Ls($):$,v=m==="tennis"?20:14,P=([$,ae,ue],Ae=0)=>ua(v*8,we=>{let ye=1+Ae*Math.cos(v*we),Oe=Math.sin(we),ce=Math.cos(we);return h([ae*ye*Oe,$,ue*ye*ce],Oe,ce)});e.finish=o;let X=["sweetheart_dress","halter_gown","one_shoulder_dress"].includes(t.outfitStyle);if(e.markPart("skirt"),X)A=Ii(e,t.outfitStyle,g,f,W,V,Y,C,a,s,p,h);else if(q){A=c?t.outfitStyle==="sweater_dress"?.73:.97:m==="midi_skirt"?2.09:m==="tennis"?.41:.56;let $=["skirt","midi_skirt","tennis"].includes(m)&&!c,ae=t.outfitStyle==="bodycon"?.008:$?.074:.023,ue=t.outfitStyle==="bodycon"?1.07:m==="tennis"?1.5:m==="midi_skirt"?1.48:1.33,Ae=w(A),we=Math.max(l+.145,Ae.rz+.17),ye=Math.max(i*ue,(Ae.x+Ae.rx+.055)/(1-ae)),Oe=a-A*s,ce=P([Oe,ye,we],ae),ve=P([Oe+.045,ye-.004,we-.004],ae);nt(e,[P(W),P(V)],c?f:_(g,f,.26));let Re=[p(1.91),Rt(V[1],Y,.56),Rt(V[2],C,.54),.003],ie=x=>P(x,x[3]);if(nt(e,ee([[...V,0],Re]).map(ie),g),nt(e,[...ee([Re,[p(2.18),Y,C,ae*.2],[a,Rt(Y,ye,.37),Rt(C,we,.4),ae*.75]]).map(ie),ve],g,{pleats:$?v:0}),nt(e,[ve,ce],_(g,f,.44),{capBottom:!0}),m==="skirt"&&!c){let x=(I+H)*.5,fe=(W[2]+V[2])*.5+.011,ge=[[-.065,-.032],[.065,-.032],[.065,.032],[-.065,.032],[-.065,-.032]];e.tube(ge.map(([U,te])=>h([U,x+te,fe],U/W[1],1)),.012,f,{sides:7})}}let oe=y==="sheer"?_(t.skinColor,u.legwearColor,.53):t.skinColor;for(let $ of[-1,1]){e.markPart($>0?"leftLeg":"rightLeg");let ae=(ye,Oe=0)=>Ai(w,a,s,$,ye,Oe);if(!q){let ye=([U,te,K])=>ua(32,ne=>{let he=$*Math.max(0,Math.sin(ne)),Z=Math.cos(ne);return h([te*he,U,K*Z],he,Z)}),Oe=U=>{if(m==="court_shorts")return .082+.066*Math.max(0,U);if(m==="flare_jeans")return .028+.155*Math.max(0,(U-1.55)/1.85);if(m==="pleat_trousers"){let te=w(.32).rx+.09,K=w(.32).rx*.55+.06,ne=Rt(te,K,Math.min(1,Math.max(0,(U-.32)/2.99)));return Math.max(.04,ne-w(U).rx)}return m==="baggy_jeans"||m==="trousers"?.052+.105*Math.max(0,Math.min(1,(U-.6)/1.8)):m==="cargo_pants"?.071+.045*Math.sin(Math.PI*Math.max(0,U)/3.58):m==="leggings"||m==="briefs"?.009:.035},ce=(U,te=0)=>{let K=Oe(U);return de&&!Q&&(K*=Math.max(0,Math.min(1,(A-U)/.31))),ae(U,K+te)},ve=ye([a+.065,Y,C]),Re=Math.min(.32,A*.55),ie=ce(Re),x=ve.map((U,te)=>U.map((K,ne)=>Rt(K,ie[te][ne],.46))),fe=Na(Re,A-.041).map(U=>ce(U)),ge=ce(A);if(m==="court_shorts"){let U=Na(Re,A-.046,.09).map(ne=>ce(ne,.009)),te=U.flatMap(ne=>ne.slice(6,10)),K=[];for(let ne=1;ne<U.length;ne++)for(let he=1;he<4;he++){let Z=ne*4+he;K.push([Z-5,Z-1,Z-4],[Z-4,Z-1,Z])}e.mesh(te,K,f),nt(e,[ce(A-.075,.009),ce(A-.039,.009)],f,{flip:$<0})}if(m==="pleat_trousers"){nt(e,[ce(A-.105,.015),ce(A,.015)],_(g,f,.3),{flip:$<0});for(let U of[0,1]){let te=Na(Re,A-.108,.1).map(K=>{let[ne,he,Z]=ce(K)[U];return[ne,he,Z+.009]});e.tube(te,U?.006:.009,_(g,f,U?.16:.4),{sides:6})}}e.finish=o,nt(e,[ye(W),ye(V)],_(g,f,.22),{flip:$<0}),nt(e,[...ee([V,[p(1.94),Rt(V[1],Y,.51),Rt(V[2],C,.52)],[p(2.18),Y,C],[a+.065,Y,C]]).map(ye),x,...fe],g,{flip:$<0}),nt(e,[fe.at(-1),ge],_(g,f,m==="denim"||m==="baggy_jeans"?.37:.1),{flip:$<0,capBottom:!0})}if(d)continue;e.finish=0;let ue=Math.max(-.2,A-.016),Ae=D+.019;if(ue<Ae){let ye={stockings:.91,knee_socks:1.8,leg_warmers:2.54,ankle_socks:2.99}[y]??Ae,Oe=u.legwearColor||"#ece9ec",ce=Math.min(Ae,Math.max(ue,ye));if(ce>ue&&nt(e,Na(ue,ce).map(ve=>ae(ve)),oe,{flip:$<0}),ce<Ae){let ve=ie=>ae(ie,y==="leg_warmers"?.039+.013*Math.cos(30*ie):.012),Re=Math.min(Ae,ce+.08);nt(e,[ve(ce),ve(Re)],_(Oe,"#3a2a40",.12),{flip:$<0}),Re<Ae&&nt(e,Na(Re,Ae,.075).map(ve),Oe,{flip:$<0})}}let we=["stockings","knee_socks","ankle_socks"].includes(y)&&u.legwearColor;Ti(e,E,u,we||oe,$,w(3.34).x,n,s,w)}e.finish=0}var Ys=2*Math.PI,Mo=(e,t,a)=>Math.max(t,Math.min(a,e)),ze=e=>Math.exp(-e*e),da=(e,t,a)=>e+(t-e)*a;function Si(e){let t=(s,n)=>{let r=e[s],i=e[s+1];return(i[n]-r[n])/(i[0]-r[0])},a=e.map((s,n)=>[1,2,3].map(r=>{if(n===0)return t(0,r);if(n===e.length-1)return t(n-1,r);let i=t(n-1,r),l=t(n,r);return i*l>0?2*i*l/(i+l):0}));return s=>{let n=1;for(;n<e.length-1&&s>e[n][0];)n++;let r=e[n-1],i=e[n],l=i[0]-r[0],p=Mo((s-r[0])/l,0,1),h=p*p,c=h*p;return[1,2,3].map(o=>(2*c-3*h+1)*r[o]+(c-2*h+p)*l*a[n-1][o-1]+(-2*c+3*h)*i[o]+(c-h)*l*a[n][o-1])}}function Us(e){return e.chestShape?e.chestShape==="pectoral":e.genderStyle==="masculine"}function Cs(e){return .86*(.61+.39*e.chestWidth)+.09*(e.shoulderWidth-1)+.065*((e.depth??1)-1)+.13*(e.ribWidth??0)+(Us(e)?.045:0)}function bi(e,t,a){let s=e.waistDefinition??0,n=e.hipCurve??0,r=e.bellyFullness??0;if(!s&&!n&&!r)return l=>l;function i(l,p,h,c){let o=Mo(l<h?(l-p)/(h-p):(c-l)/(c-h),0,1);return o*o*(3-2*o)}return(l,p,h)=>{let c=(t-l[1])/a;if(c<=.96||c>=2.58)return l;let o=.082*s*i(c,1.08,1.49,1.96),d=.132*n*i(c,1.54,1.98,2.53),u=r*(r>0?.24:.087)*i(c,.96,1.76,2.58);return[l[0]+(d-o)*p,l[1],l[2]+(.28*d-.21*o)*h+u*Math.max(0,h)**2]}}function Ds(e,t){let{shoulder:a,length:s}=t,n=I=>a-I*s,r=t.shoulders,i=.66*e.waistWidth,l=t.hips,p=.45*(e.gluteFullness??1),h=.224*e.neckWidth,c=.18+.32*e.shoulderSlope,o=(a+.47*e.headScale)/s,d=e.depth??1,u=t.chest,m=.413*d+.034*(e.ribWidth??0),g=Mo((e.chestWidth-.7)/.68,0,1),f=Us(e),E=e.bustProjection??0,y=e.bustSpacing??0,w=f?(.042+.16*g)*(1+.55*E):(.033+.347*g)*(1+.62*E)+.048*Math.max(0,E),k=Math.min(w,.225),Y=(f?.59+.06*g:.676+.117*g)-.145*(e.bustHeight??0),C=.395+.12*y,q=Math.asin(C),Q=bi(e,a,s),de=Si([[o,h*.91,h*.93,-.041],[o*.64,h*.85,h*.87,-.036],[o*.23,h*.94,h*.91,-.023],[0,h*1.23,h*1.01,-.011],[.36*c,r*.58,.29,-.014],[.8*c,r*.87,.343,-.024],[c+.036,r*.958,.36,-.031],[.42,da(r*.9,u,.72),m*.96,-.034],[.7,u,m*1.08,-.03],[.92,u*.994,m*1.06,-.02],[1.09,u*.957,m*.994,-.007],[1.26,da(u*.89,i,.32),da(m,.345,.32),.002],[1.43,da(u*.88,i,.8),da(m,.34,.67),.005],[1.57,i,.344,0],[1.6,i*.992,.342,0],[1.81,da(i,l,.36),da(.35,p,.39),0],[2.18,l,p,0],[2.59,l*.9,p*.91,0]]);function D(I,H,W=0,V=0,ee=!1){let v=Math.sin(H),P=Math.cos(H),X=Math.abs(v),[oe,$,ae]=de(I),ue,Ae=(oe+W)*v;if(P>=0){let we=ee?k:w,ye;if(f){let ie=I-Y+.1*X*X,x=Math.exp(-((ie/(ie<0?.38:.29))**4)),fe=Math.exp(-(((X-C)/.55)**4)),ge=.16*(1-V)*ze(v/(.1+.035*y));ye=we*(fe-ge)*x}else{let ie=C+.045*Math.tanh((I-Y)*4),x=I-Y+.065*X,fe=ze(x/(x<0?.38:.325)),ge=.38+.043*y,U=ze((v-ie)/ge)+ze((v+ie)/ge),te=ze(v/.19)*ze((I-Y+.06)/.27),K=we*V*.75*ze(v/.34)*fe;ye=we*(U*fe-.135*te)+K,Ae+=.15*y*v*P*P*fe}let Oe=.23-.095*X+.015*ze((X-.7)/.16),ce=.026*ze((I-Oe)/.053)*(1-ze(X/.13))*ze((X-.48)/.47),ve=.025*ze(v/.13)*ze((I-.105)/.082),Re=.023*ze((I-1.33)/.22)*ze(v/.56);ue=(ye+ce-ve+Re)*P*P}else{let we=.043*ze((X-.48)/.28)*ze((I-.51)/.34),ye=.022*ze(v/.13)*ze((I-.72)/.64);ue=-(we-ye)*P*P}return Q([Ae,n(I),ae+($+W)*P+ue],v,P)}function M(I,H){let W=Math.cos(H);if(I<0){let P=Mo(I/o,0,1);return(.2+.1*Math.max(0,W))*P**1.4}if(W<=0)return 0;let V=Math.abs(Math.sin(H)),ee=(f?.012+.018*g:.038+.115*g)*(1+.2*E-.2*y)*ze(V/(.095+.025*g))*ze((I-Y+.018)/.24),v=.033*ze(V/.67)*ze((I-.25+.09*V)/.048);return(ee+v)*W*W}function A(I,H,W){let V=Math.cos(H);if(V<=0)return 0;let ee=Math.abs(Math.sin(H));if(f){let X=Y+.27-.1*ee*ee;return w*.23*(1-.7*W)*V*V*ze((ee-C)/.48)*ze((I-X)/.1)}let v=(ee-C)/.45,P=Y+.16+.14*Math.max(0,1-v*v);return Math.min(w,.55)*.38*(1-.69*W)*V*V*ze(v)*ze((I-P)/.14)}return{y:n,shoulders:r,waist:i,hips:l,hipDepth:p,neck:h,slope:c,chest:u,neckTop:o,bustCenter:Y,bustAngle:q,softenNormals:k<w,section:de,ring:D,occlusion:M,fabricShade:A,shapeContour:Q}}function Ro(e,t,a,s,n,{shading:r=null,normalRing:i=null,rows:l=28,sides:p=88}={}){let h=[],c=[],o=i?[]:h,d=r?[]:null;for(let u=0;u<=l;u++)for(let m=0;m<p;m++){let g=m<p/2?Ys*m/p:Ys*(m-p)/p,f=da(a(g),s(g),u/l);if(h.push(t(f,g)),i&&o.push(i(f,g)),r&&d.push(r(f,g)),u>0){let E=(u-1)*p+m,y=(u-1)*p+(m+1)%p;c.push([E,E+p,y],[y,E+p,y+p])}}e.mesh(h,c,n,o,d)}var aa=Math.PI*2,De=(e,t,a)=>e+(t-e)*a,ta=(e,t,a)=>{let s=Math.max(0,Math.min(1,(a-e)/(t-e)));return s*s*(3-2*s)},oa=e=>Math.acos(Math.max(-1,Math.min(1,Math.cos(e)))),Ps={dinner_jacket:{dress:!1,sleeve:"long",untucked:!0,neckline(e){return-.055+.12*Math.max(0,Math.cos(e))**3},hem(e){return 1.92+.12*Math.sin(e)**2}},rugby_shirt:{dress:!1,sleeve:"short",neckline(e){return-.045+.19*Math.max(0,Math.cos(e))**5}},western_shirt:{dress:!1,sleeve:"long",neckline(e){return-.015+.2*Math.max(0,Math.cos(e))**2}},wrap_work_jacket:{dress:!1,sleeve:"long",untucked:!0,neckline(e){return .02+.47*Math.max(0,1-oa(e)/1.02)},hem(e){return 2.04+.1*Math.sin(e)**2}},tailored_waistcoat:{dress:!1,sleeve:"long",neckline(e){return-.03+.15*Math.max(0,Math.cos(e))**3}},field_overshirt:{dress:!1,sleeve:"long",untucked:!0,hem(e){return 1.8+.16*Math.cos(e)**2},neckline(e){return-.035+.22*Math.max(0,Math.cos(e))**4}},contrast_henley:{dress:!1,sleeve:"short",neckline(e){return .068+.18*Math.max(0,Math.cos(e))**3}},mariner_blouse:{dress:!1,sleeve:"short",neckline(e){return .06+.53*Math.max(0,1-oa(e)/1.14)}},one_shoulder_dress:{dress:!0,sleeve:"none",neckline(e){return .075+.54*(1-ta(-.45,.72,Math.sin(e)))+.04*Math.cos(e)**2}},track_jacket:{dress:!1,sleeve:"long",neckline(e){return-.105+.11*Math.max(0,Math.cos(e))**12}},sweetheart_dress:{dress:!0,sleeve:"none",neckline(e){let t=oa(e);return .59+.2*Math.exp(-((t/.23)**2))-.19*Math.exp(-(((t-.55)/.39)**2))+.055*ta(1.75,2.93,t)}},wrap_blouse:{dress:!1,sleeve:"long",neckline(e){let t=oa(e);return .098+.71*Math.max(0,1-t/1.14)**1.27+.09*ta(1.72,2.95,t)}},square_knit:{dress:!1,sleeve:"short",neckline(e){let t=oa(e);return .097+.42*(1-ta(.45,.81,t))+.19*ta(2.24,2.69,t)}},halter_gown:{dress:!0,sleeve:"none",neckline(e){let t=oa(e);return .006+.82*Math.max(0,1-t/.61)+.645*ta(.78,1.47,t)+.09*ta(1.75,3,t)}}};function On(e){return Object.hasOwn(Ps,e)?Ps[e]:null}function ht(e,t,a,s){let n=[],r=[];for(let i=0;i<=t;i++)if(n.push(...a(i/t)),i){let l=i*2;r.push([l-2,l,l-1],[l-1,l,l+1])}e.mesh(n,r,s)}function Ot(e,t,a,s,n,r=0){ht(e,96,i=>{let l=aa*i,p=t(l)+r;return[a(p,l,.025),a(p+s,l,.026)]},n)}function Dt(e,t,a,s,n=.006,r=.032){let i=Array.from({length:39},(l,p)=>{let[h,c]=a(p/38);return t(h,c,r)});e.tube(i,n,s,{sides:7})}function Hi(e,t,a,s,n){let r=c=>a(c,Math.PI/2)[0],l=Math.sin(.56)*r(t(.56)),p=r(t(.56))*.034,h=(c,o,d)=>{let u=l+c*p,m=0,g=.36;for(let f=0;f<12;f++){let E=(m+g)/2;r(E)<u?m=E:g=E}return f=>{let E=f>.5,y=t(E?Math.PI-.56:.56)+.038,w=De(g,y,Math.cos(Math.PI*f)**2),k=Math.asin(Math.min(1,u/r(w)));return a(w,o*(E?Math.PI-k:k),d)}};for(let c of[-1,1]){let o=h(-1,c,.009),d=h(1,c,.009);ht(e,64,g=>[o(g),d(g)],s);let u=h(-.83,c,.011),m=h(-.57,c,.011);ht(e,64,g=>[u(g),m(g)],n)}}function oo(e,t,a,s,n){ht(e,72,r=>[t(a,aa*r,.032),t(a+s,aa*r,.033)],n)}function ma(e,t,a,s,n,r,i,l=.044){let p=[],h=[],c=Math.max(16,Math.ceil(16*Math.abs(s-a))),o=12;for(let d=0;d<=o;d++)for(let u=0;u<=c;u++){let m=De(a,s,u/c);if(p.push(t(De(n(m),r(m),d/o),m,l)),u&&d){let g=p.length-1;h.push([g-c-2,g-1,g-c-1],[g-c-1,g-1,g])}}e.mesh(p,h,i)}function no(e,t,a,s,n,r,i,l=.064){ht(e,56,p=>{let h=De(a,s,p),c=n(p),o=r(p);return[t(h,c-o,l),t(h,c+o,l)]},i)}function Gs(e,t,a){let s=t.outfitStyle,n=On(s);if(!n)return;let{ring:r}=a,i=t.outfitPrimary,l=t.outfitAccent,p=_(i,l,.62),h=_(i,"#292032",.24),c=n.neckline;if(s==="dinner_jacket"){let o=_("#faf1e2",i,.06);ma(e,r,-.98,.98,c,f=>c(f)+.89*Math.max(0,1-Math.abs(f)/.98),o);for(let f of[-1,1]){no(e,r,.02,1.14,E=>f*De(.95,-.05,E),E=>.034+.22*Math.sin(Math.PI*E)**.8,l,.082),Dt(e,r,E=>[1.34-.085*E,f*De(.43,1.08,E)],l,.023,.08);for(let E of[1.12,1.39])e.ellipsoid(r(E,f*.255,.083),[.041,.041,.022],_(i,l,.68),{sides:12,rings:7})}ma(e,r,.42,.92,f=>.68-.13*Math.abs(Math.sin((f-.42)*11)),()=>.73,o,.079),Dt(e,r,f=>[.73-f*.02,.4+f*.55],l,.019,.089);let[u,m,g]=r(.193,0,.115);for(let f of[-1,1]){let E=[[0,0,.012],[.21,.086,-.012],[.22,.013,-.005],[.2,-.078,0],[.05,-.029,.015],[.105,.012,.039]];e.mesh(E.map(([y,w,k])=>[u+f*y,m+w,g+k]),[[0,1,5],[1,2,5],[2,3,5],[3,4,5],[4,0,5]],l)}e.ellipsoid([u,m,g+.028],[.043,.043,.03],l,{sides:12,rings:6})}else if(s==="rugby_shirt"){for(let o of[.43,1.04])ma(e,r,0,aa,()=>o,()=>o+.26,l),Ot(e,()=>o+.3,r,.03,l);for(let o of[-1,1])ma(e,r,o<0?-1.36:.025,o<0?-.025:1.36,c,d=>c(d)+.048+.25*(1-Math.abs(Math.abs(d)-.48)/1.04),t.outfitSecondary,.067);no(e,r,c(0),.5,()=>0,()=>.066,_(i,l,.65),.076);for(let o of[.24,.37])e.ellipsoid(r(o,0,.087),[.022,.022,.015],l,{sides:10,rings:5})}else if(s==="western_shirt"){let o=d=>.34+.24*Math.max(0,1-Math.abs(oa(d)-.63)/.52)+.2*ta(2.26,Math.PI,oa(d));ma(e,r,0,aa,c,o,_(i,l,.48)),Ot(e,o,r,.033,l);for(let d of[-1,1]){let u=f=>.74+.09*Math.abs(Math.sin((Math.abs(f)-.32)*9.8)),m=d<0?-.98:.32,g=d<0?-.32:.98;ma(e,r,m,g,()=>.7,u,_(i,l,.45),.061),Dt(e,r,f=>{let E=De(m,g,f);return[u(E),E]},l,.009,.069),ma(e,r,d<0?-1.15:.025,d<0?-.025:1.15,c,f=>c(f)+.02+.26*Math.max(0,1-Math.abs(Math.abs(f)-.59)/.55),i,.073)}no(e,r,c(0),1.57,()=>0,()=>.054,_(i,l,.17),.067);for(let d of[.29,.54,.79,1.04,1.29,1.54])e.ellipsoid(r(d,0,.079),[.029,.029,.018],_(l,"#fff9e2",.64),{sides:10,rings:6})}else if(s==="wrap_work_jacket"){Ot(e,c,r,.128,l),no(e,r,c(0)+.058,1.44,o=>.92*o,()=>.105,l),ma(e,r,0,aa,o=>1.34+.041*Math.sin(o),o=>1.55+.041*Math.sin(o),l,.072);for(let[o,d]of[[.3,1.92],[-.16,1.83]])no(e,r,1.45,d,u=>.92+o*u,u=>.055-.017*u,l,.096);e.ellipsoid(r(1.46,.92,.102),[.075,.081,.052],_(l,i,.32),{sides:14,rings:8}),Ot(e,o=>n.hem(o)-.035,r,.029,_(i,l,.65))}else if(["tailored_waistcoat","field_overshirt","contrast_henley"].includes(s)){let o=s==="tailored_waistcoat",d=s==="contrast_henley",u=o?[.77,.97,1.17,1.37]:d?[.31,.43,.55]:[.32,.58,.84,1.1,1.36],m=o?l:_(i,d?l:t.outfitSecondary,.32),g=d?.6:n.hem?.(0)??1.56;if(ht(e,48,f=>{let E=De(c(0),g,f);return[r(E,-.054,.054),r(E,.054,.054)]},o?h:m),o)for(let f=0;f<12;f++)ht(e,48,E=>{let y=De(-1.25,1.25,E),w=c(y)+.58*(1-Math.abs(y)/1.25);return[r(De(c(y),w,f/12),y,.061),r(De(c(y),w,(f+1)/12),y,.061)]},l);for(let f of[-1,1])if(d)for(let E=0;E<8;E++)ht(e,40,y=>{let w=De(.85,Math.PI-.7,y),k=.02+.54*Math.sin(Math.PI*y);return[r(c(w)+k*E/8,f*w,.04),r(c(w)+k*(E+1)/8,f*w,.04)]},l);else{ht(e,36,y=>{let w=f*De(.045,1.26,y),k=.245*(1-Math.abs(2*y-1));return[r(c(w),w,.074),r(c(w)+.034+k,w,.074)]},o?_(l,i,.18):m);let E=o?1.22:.62;if(!o)for(let y=0;y<6;y++)ht(e,27,w=>{let k=f*De(.28,.92,w),Y=.29+.065*Math.sin(Math.PI*w);return[r(E+Y*y/6,k,.045),r(E+Y*(y+1)/6,k,.045)]},_(i,l,.2));ht(e,28,y=>{let w=f*De(.27,.95,y),k=E-(o?.115*y:0);return[r(k,w,.065),r(k+(o?.036:.08+.04*Math.sin(Math.PI*y)),w,.065)]},o?_(i,l,.4):h)}Ot(e,c,r,d?.052:.026,d?l:m),n.untucked&&Ot(e,f=>n.hem(f)-.026,r,.024,_(i,l,.2));for(let f of u)e.ellipsoid(r(f,0,.077),[.032,.031,.019],o?l:h,{sides:10,rings:6})}else if(s==="mariner_blouse"){let o=d=>{let u=oa(d);return .19+.57*Math.max(0,1-u/1.1)+.57*ta(1.36,2.22,u)};for(let d=0;d<10;d++)ht(e,112,u=>{let m=u*aa,g=c(m),f=o(m);return[r(De(g,f,d/10),m,.035),r(De(g,f,(d+1)/10),m,.035)]},_(i,l,.47));for(let d of[.04,.09])ht(e,112,u=>{let m=u*aa,g=o(m)-d;return[r(g,m,.046),r(g+.018,m,.046)]},i);for(let d of[-1,1])ht(e,40,u=>{let m=d*(.035+.235*u),g=.61+.47*u,f=.06*(1-.64*u);return[r(g,m-f,.06),r(g+.026*u,m+f,.059)]},l);e.ellipsoid(r(.62,0,.055),[.061,.055,.044],_(l,i,.18),{sides:14,rings:9}),oo(e,r,1.515,.057,_(i,l,.3))}else if(s==="one_shoulder_dress"){Ot(e,c,r,.071,_(i,l,.42)),Ot(e,c,r,.017,l,.009);for(let d=0;d<3;d++){let u=.55+.24*d;Dt(e,r,m=>[De(u,1.36+.028*d,m)+.12*Math.sin(Math.PI*m),De(.73,-.95,m)],_(i,l,.18),.014)}let o=r(1.395,-.95,.07);e.ellipsoid(o,[.07,.064,.045],l,{sides:15,rings:9})}else if(s==="track_jacket"){let o=d=>.38+.39*Math.abs(Math.cos(d))**3;Ot(e,o,r,.135,l),Ot(e,o,r,.023,_(i,"#222438",.54),.146),Ot(e,c,r,.032,l),ht(e,50,d=>{let u=De(c(0),1.56,d);return[r(u,-.031,.057),r(u,.031,.057)]},h),Dt(e,r,d=>[De(c(0),1.57,d),0],_(l,"#b3b7bd",.42),.01,.064),e.ellipsoid(r(.35,0,.078),[.034,.063,.024],l,{sides:12,rings:8});for(let d of[-1,1])Dt(e,r,u=>[1.11+.24*u,d*(.68-.32*u)],h,.017);oo(e,r,1.47,.095,_(i,"#332d43",.35))}else if(s==="sweetheart_dress"){Hi(e,c,r,i,p),Ot(e,c,r,.027,p);for(let o of[-1,1])for(let d of[!1,!0]){let u=m=>{let g=.48+.15*Math.sin(Math.PI*m)-.12*m;return o*(d?Math.PI-g:g)};Dt(e,r,m=>[De(c(u(0))+.027,1.57,m),u(m)],h,.009)}oo(e,r,1.51,.045,p)}else if(s==="wrap_blouse"){Ot(e,c,r,.045,_(i,l,.34));let o=m=>[De(c(0),1.49,m),De(0,1.04,m)];ht(e,56,m=>{let[g,f]=o(m);return[r(g,f,.038),r(g+.055,f,.035)]},_(i,l,.34)),Dt(e,r,o,h,.006,.044);let d=_(i,l,.47);oo(e,r,1.39,.116,d);let u=r(1.451,1.06,.055);e.ellipsoid(u,[.059,.048,.052],l,{sides:14,rings:9});for(let m of[-1,1])ht(e,23,g=>{let f=De(1.47,1.597,g),E=1.06+m*.29*g;return[r(f,E-.029,.053),r(f+.012,E+.029,.052)]},d)}else if(s==="square_knit"){Ot(e,c,r,.065,_(i,l,.47)),Ot(e,c,r,.015,l,.047),oo(e,r,1.48,.079,_(i,l,.34));for(let o of[-1,1])for(let d of[.52,.57]){let u=o*d;Dt(e,r,m=>[De(c(u)+.073,1.479,m),u+o*.026*Math.sin(Math.PI*m)],_(i,l,.24),.006)}}else{ht(e,88,d=>{let u=De(.64,aa-.64,d);return[r(-.034,u,.013),r(.018,u,.013)]},i),Ot(e,c,r,.022,p);for(let d of[-1,1])Dt(e,r,u=>[De(.57,1.5,u),d*De(.64,.12,u)],_(i,l,.25),.008),Dt(e,r,u=>[De(.64,1.5,u),d*De(.82,.23,u)],h,.007);let o=r(1.5,0,.052);e.ellipsoid(o,[.075,.04,.022],l,{sides:16,rings:8})}}function An(e){let t=-.57*e.headScale-.39*e.neckLength,a=e.torsoLength*e.bodyScale,s=t-2.59*a,n=(e.legLength??1)*e.bodyScale,r=.96*e.shoulderWidth,i=.84*e.hipWidth,l=e.posture==="confident"||e.posture==="presenter",p=(e.armLength??1)*e.bodyScale,h=t-(.18+.32*e.shoulderSlope)*a,c={posed:l,reach:p,root:h,elbow:[r+.16,h-1.28*p,.042],wrist:[r+(l?-.36:.2),h-(l?2.14:2.58)*p,.17+(l?.3:0)]};return{shoulder:t,shoulders:r,length:a,hip:s,hips:i,leg:n,arm:c,chest:Cs(e),floor:s-3.58*n}}function _s(e,t,a){let s=[];for(let n=1;n+1<t.length;n++)s.push([0,n,n+1]);e.mesh(t,s,a)}function wi(e,t,a,s,n,r){for(let i of[-1,1])_s(e,[[0,0,0],[.93,.36,-.06],[1,.02,-.1],[.85,-.36,-.04],[.2,-.14,.1]].map(([p,h,c])=>[t+i*p*n,a+h*n,s+c*n]),r),_s(e,[[t,a,s],[t+i*n*.45,a-n*.9,s-.01],[t+i*n*.72,a-n*.69,s-.015]],r);e.ellipsoid([t,a,s+.01],[n*.21,n*.2,n*.14],r)}var yn=.88;function Tn([e,t,a],s,n,r,i,l){let p=Math.cos(yn),h=Math.sin(yn);return[e+s*(r*p-l*h)*n,t+i*n,a-(r*h+l*p)*n]}function Ni(e,t,a,s,n){let r=(p,h,c)=>Tn(t,a,s,p,h,c),i=(p,h,c)=>[p*s,h*s,c*s];e.ellipsoid(r(0,-.115,.019),i(.102,.168,.079),n,{rotation:[.12,a*yn,a*.06]});let l=a<0?"right":"left";for(let[p,h]of[.159,.181,.167,.133].entries()){p<2&&e.markPart(l+(p===0?"Index":"Fingers"));let c=-.066+p*.044,o=[r(c,-.194,.018),r(c*1.05,-.23-h*.33,.023),r(c*1.03,-.214-h*.87,.053),r(c*.96,-.211-h,.069)];e.tube(o,[.03,.025,.022,.012].map(d=>d*s),n,{sides:10})}e.markPart(l+"Thumb"),e.tube([r(-.061,-.072,.006),r(-.112,-.134,.046),r(-.135,-.196,.081),r(-.123,-.239,.095)],[.046,.04,.031,.013].map(p=>p*s),n,{sides:12})}function Lt(e,t,a,s,n=.025){let r=[],i=[];function p(h,c,o){let d=r.length/13;for(let u=0;u<=12;u++){r.push(t(h,c+(o-c)*u/12,n));let m=r.length-1;d&&u&&i.push([m-12-2,m-1,m],[m-12-2,m,m-12-1])}}p(...a[0]);for(let h=1;h<a.length;h++){let[c,o,d]=a[h-1],[u,m,g]=a[h],f=Math.max(1,Math.ceil(Math.abs(u-c)/.075));for(let E=1;E<=f;E++){let y=E/f;p(c+(u-c)*y,o+(m-o)*y,d+(g-d)*y)}}e.mesh(r,i,s)}function Mi(e){let t=["tee","sweater","sweater_dress","apron","oversized_tee"].includes(e);return a=>{let s=Math.max(0,Math.cos(a)),n=Math.abs(a),r=.57+.16*Math.exp(-((n/.255)**2))-.13*Math.exp(-(((n-.56)/.38)**2));switch(e){case"satin":case"cocktail":case"corset_top":case"bodycon":return r;case"wrap_dress":return .09+.7*Math.max(0,1-n/1.2)**1.12+.11*Math.max(0,-Math.cos(a));case"peasant_blouse":case"sleeved":return .13+.42*s**3+.16*Math.max(0,-Math.cos(a));case"scoop":return .08+.48*s**3;case"sweater":return-.018+.12*s**2;case"camisole":case"bra":return .54+.18*s**4-.1*Math.exp(-(((n-.54)/.27)**2));case"halter":return .51+.23*Math.max(0,1-n/.62);case"overall_dress":return .1+.2*s**2;default:return t?.04+.22*s**2:-.018}}}function Ri(e,t,a,s,n){let i=["camisole","bra","satin"].includes(t)?.041:.1,l=t==="halter",p=[],h=[];for(let c of[-1,1]){let o=p.length;for(let d=0;d<=44;d++){let u=d/44,m=.54+(Math.PI-1.08)*u,g=l?.023:.08,f=u<.5?s(c*.54):s(c*(Math.PI-.54)),E=g+(f+.02-g)*Math.abs(2*u-1)**1.6;for(let y of[-1,1])p.push(a(E+y*.12*i*Math.sin(m)**3,c*(m+y*i*Math.cos(m)),.017));if(d){let y=o+d*2;h.push([y-2,y,y-1],[y-1,y,y+1])}}}e.mesh(p,h,n)}function Wi(e,t,a,s){let{outfitStyle:n,outfitPrimary:r,outfitSecondary:i,outfitAccent:l}=t,p=_(r,"#30283d",.27);if(n==="apron"){Lt(e,a,[[.48,-.49,.49],[.68,-.5,.5],[1.04,-.57,.57],[1.57,-.89,.89],[2.18,-.96,.96],[2.59,-.98,.98],[2.83,-.98,.98]],i,.14);for(let c of[-1,1]){let o=[[.02,.84],[.18,.46],[.32,.46],[.49,.47]].map(([d,u])=>a(d,c*u,.14));e.tube(o,.035,i)}Lt(e,a,[[.77,-.3,.3],[1.02,-.29,.29],[1.11,-.21,.21]],_(i,r,.22),.16),Lt(e,a,[[.78,-.3,.3],[.82,-.3,.3]],l,.18);let h=s(1.54,Math.PI,.025);for(let c of[-1,1]){let o=[[0,.02],[.24,.1],[.39,.025],[.22,-.03],[0,.02],[.2,-.43]];e.tube(o.map(([d,u])=>[c*d,h[1]+u,h[2]-.04]),.023,i,{sides:8})}}else if(n==="hoodie"){for(let h of[-1,1]){let c=[[.15,.36],[.29,.31],[.48,.28],[.64,.25],[.82,.3]].map(([o,d])=>a(o,h*d,.079));e.tube(c,.015,i,{sides:8}),e.tube(c.slice(-2),.021,l,{sides:8})}Lt(e,a,[[1.16,-.41,.41],[1.37,-.7,.7],[1.56,-.69,.69]],p,.029)}else if(["shirt","blouse","polo","polo_knit"].includes(n)){let h=n==="blouse",c=h||n==="shirt",o=[.24,.5,.67,.81];c&&o.push(1.03,1.34,1.59),Lt(e,a,o.map(d=>[d,-.038,.038]),h?_(r,l,.29):p);for(let d of c?[.46,.71,.96,1.21,1.46]:[.46,.69])e.ellipsoid(a(d,0,.05),[.024,.024,.013],h?_(l,"#9c7176",.32):i,{sides:12,rings:6});n==="shirt"&&Lt(e,a,[[.61,-.7,-.33],[.84,-.68,-.34],[.91,-.5,-.49]],_(r,i,.2),.035)}else if(n==="tee")for(let[h,c,o]of[[.19,l,.009],[.088,i,.014]]){let d=Array.from({length:25},(u,m)=>{let g=Math.PI*m/24,f=h*1.14*Math.sin(g);return[.78-h*Math.cos(g),-f,f]});Lt(e,a,d,c,o)}else if(n==="cyber"){let h=[];for(let o=0;o<=32;o++){let d=-.7+o*1.4/32,u=.6-.56*Math.max(0,Math.abs(d)-.2);h.push(a(u,d,.027))}e.tube(h,.019,l,{sides:8});let c=a(.6,0,.034);e.ellipsoid(c,[.096,.096,.022],_(r,l,.44)),e.ellipsoid([c[0],c[1],c[2]+.016],[.054,.054,.014],l)}}function Bs(e,t,a=vs){e.markPart("torso");let s=An(t),{shoulder:n,hip:r,length:i,leg:l,floor:p}=s,h=t.wardrobe||{},c=t.outfitStyle,o=t.outfitPrimary,d=t.outfitAccent,u=t.outfitSecondary,m=_(t.skinColor,"#b5cde0",(t.synthFinish||0)*.28),g=h.outerwear||"none",f=Ds(t,s),{shoulders:E,waist:y,hips:w,hipDepth:k,neck:Y,slope:C,y:q}=f,Q=On(c),de=["blazer","suit_tie","jacket","cardigan","vest"].includes(c),D=Q?Q.sleeve==="none":["satin","cocktail","sleeved","bodycon","halter","camisole","corset_top","bra","wrap_dress","overall_dress"].includes(c),M=Q?Q.dress:["satin","cocktail","sleeved","bodycon","wrap_dress","overall_dress","sweater_dress"].includes(c),A=["blouse","shirt","blazer","suit_tie","polo","polo_knit","vest","overall_dress"].includes(c),I=de?u:o,H=g!=="none"?h.outerColor:o,W=de||g!=="none",V={knit:1,satin:2,velvet:3,denim:4},ee=V[h.topFabric]||0,v=Q?.neckline??Mi(c),P=Q?.hem??(()=>1.6),X=Q?.untucked||["hoodie","oversized_tee","sweater","sweater_dress","peasant_blouse"].includes(c)?.98:D||Q?.22:.68,oe=ie=>.014+(Q?.untucked?.13*Math.min(1,Math.max(0,ie-.56)):0),$=(ie,x,fe=0)=>f.ring(ie,x,oe(ie)+fe,X),ae=(ie,x,fe=.025)=>$(ie,Math.asin(Math.max(-1,Math.min(1,x))),fe);e.finish=0;let ue=f.softenNormals?(ie,x)=>f.ring(ie,x,0,0,!0):null,Ae=f.softenNormals?(ie,x)=>f.ring(ie,x,oe(ie),X,!0):null;Ro(e,f.ring,()=>f.neckTop,v,m,{shading:f.occlusion,normalRing:ue,rows:31}),Q?.hem&&!Q.untucked&&Ro(e,f.ring,P,()=>1.6,m,{shading:f.occlusion,rows:14}),e.finish=ee,Ro(e,$,v,P,I,{normalRing:Ae,shading:(ie,x)=>f.fabricShade(ie,x,X)});let we=[],ye=[],Oe=[],ce=88;for(let ie=0;ie<ce;ie++){let x=ie<ce/2?Math.PI*2*ie/ce:Math.PI*2*(ie-ce)/ce,fe=v(x);we.push(f.ring(fe,x),$(fe,x)),Oe.push($(fe,x,.002));let ge=2*ie,U=2*((ie+1)%ce);ye.push([ge,ge+1,U],[U,ge+1,U+1])}if(e.mesh(we,ye,I),!Q&&!A&&v(0)>0){let ie=c==="sweater";e.tube([...Oe,Oe[0]],ie?.042:.011,ie?_(I,"#dad7dd",.16):_(I,d,.36),{sides:8})}["camisole","bra","satin","halter","overall_dress"].includes(c)&&Ri(e,c,f.ring,v,I),Wi(e,t,ae,$),Q&&Gs(e,t,{point:$,ring:$,front:ae,skinRing:f.ring,neckline:v});let ve=ae;if(W){let ie=g==="trench"?2.59+.8/i:g==="bolero"?1.02:2.1,x=g==="none"?Z=>.009+.52*Math.max(0,1-Math.max(0,Z)/(c==="suit_tie"?1.31:1.08)):Z=>.34+.39*Math.exp(-Math.max(0,Z)*2),fe=(Z,j,me=0)=>{let Ee=Math.max(0,Z-1.42),ke=.068+.106*Math.min(1,Ee*1.7)+(g==="trench"?.12*Ee:0);return f.ring(Z,j,ke+me,1.12)},ge=(Z,j,me=.025)=>fe(Z,Math.asin(Math.max(-1,Math.min(1,j))),me),U=[],te=[],K=[],ne=44,he=64;e.finish=V[g==="cardigan"?"knit":"cotton"]||0;for(let Z=0;Z<=ne;Z++){let j=-.022+(ie+.022)*Z/ne,me=x(j);K.push([j,me]);for(let Ee=0;Ee<=he;Ee++){let ke=me+(2*Math.PI-2*me)*Ee/he;U.push(fe(j,ke));let He=Z*(he+1)+Ee;Z&&Ee&&te.push([He-he-2,He-1,He-he-1],[He-he-1,He-1,He])}}e.mesh(U,te,H),ve=ge;for(let Z of[-1,1]){let j=K.map(([me,Ee])=>fe(me,Z*Ee,.002));if(e.tube(j,c==="cardigan"?.029:.014,_(H,d,c==="jacket"?.58:.17)),g==="none"){if(c==="blazer"||c==="suit_tie")Lt(e,(Ee,ke,He)=>ge(Ee,Z*(Math.sin(x(Ee))+ke),He),[[.03,0,.13],[.2,0,.29],[.31,0,.16],[.37,0,.27],[.67,0,.18],[1.06,0,.012]],_(H,"#d6d4e7",.16));else if(c==="cardigan"&&Z===1)for(let me of[1.12,1.45,1.78])e.ellipsoid(ge(me,.02,.048),[.033,.034,.017],d,{sides:12,rings:6});else if(c==="jacket")for(let me=.42;me<2;me+=.065){let Ee=Math.sin(x(me));e.tube([ge(me,Z*Ee,.029),ge(me,Z*(Ee+.037),.029)],.007,d,{sides:5})}}}}for(let ie of[-1,1]){e.markPart(ie>0?"leftArm":"rightArm");let{reach:x,posed:fe,root:ge,elbow:U}=s.arm,te=.235*t.armThickness,K=[ie*s.arm.wrist[0],s.arm.wrist[1],s.arm.wrist[2]],ne=[[q(C-.08),.05,.08,-.01,E*.78],[q(C-.03),.38,.51,-.01,E*.83],[q(C+.036),.65,.77,0,E*.89],[ge-.15*x,.89,.98,0,E*.95],[ge-.32*x,1,1.1,0,E+.025],[ge-.49*x,.97,1.06,0,E+.064],[ge-.93*x,.79,.88,.011,E+.13],[U[1],.67,.73,U[2],U[0]],[ge-1.57*x,.77,.79,.075,E+(fe?.07:.19)],[ge-1.76*x,.75,.76,.14,E+(fe?-.016:.2)],[K[1],.435,.53,K[2],Math.abs(K[0])]].map(([me,Ee,ke,He,Pe])=>[me,te*Ee,te*ke,He,Pe*ie]);e.finish=0;let he=g!=="none"&&!["puffer_vest","shawl"].includes(g),Z=Q?.sleeve==="long"||he||de||["blouse","shirt","sweater","sweater_dress","hoodie","peasant_blouse","turtleneck","cyber"].includes(c),j=!D||he||c==="sleeved";if((!j||!Z)&&e.loft(j?ne.slice(5):ne,m,{sides:22}),j){let me=(Z?ne:ne.slice(0,6)).map(([We,Xe,J,dt,Ht],it)=>{let Te=["blouse","peasant_blouse","hoodie","sweater","wrap_work_jacket"].includes(c)&&it>1&&it<10?1.21:1.09;return[We+.014,Xe*Te+.009,J*Te+.01,dt,Ht]}),ke=he||de&&c!=="vest"?H:c==="tailored_waistcoat"||c==="contrast_henley"?d:I;e.finish=ee;let[He,Pe,Ye,Ge,Le]=me.at(-1),Ze=Z?.13:.048;if(Z&&me.splice(-1,0,[He+.18,Pe*1.29,Ye*1.28,Ge-.011,Le]),e.loft(me,ke,{sides:22}),!he&&c==="rugby_shirt"){let We=me.slice(-2).map(([Xe,J,dt,Ht,it])=>[Xe,J+.006,dt+.006,Ht,it]);e.loft(We,d,{sides:22})}if(!he&&c==="western_shirt")for(let We of[.042,.108])e.ellipsoid([Le+ie*Pe*.75,He+We,Ge+Ye*.87],[.022,.022,.014],d,{sides:10,rings:5});if(!he&&c==="track_jacket")for(let We of[-.18,.24]){let Xe=me.slice(2).map(([J,dt,Ht,it,Kt])=>[Kt+ie*(dt+.005)*Math.sqrt(1-We*We),J,it+Ht*We]);e.tube(Xe,.013,d,{sides:7})}let je=Z?1.19:1.024,Ne=Z?1.05:1.009;e.loft([[He+Ze,Pe*je,Ye*je,Ge,Le],[He-.01,Pe*Ne,Ye*Ne,Ge,Le]],_(ke,d,.32),{sides:22})}e.finish=0,Ni(e,K,ie,t.handSize??1,m)}e.markPart("torso");let Re=n+.017;if(c==="turtleneck"||c==="hoodie"||t.neckwear==="scarf"){let ie=t.neckwear==="scarf",x=Y+(ie||c==="hoodie"?.14:.025);e.loft([[q(.18),x*1.22,x],[Re+.01,x*1.15,x*1.08],[Re+(c==="turtleneck"&&!ie?.2:.13),x*.95,x*.93]],ie?t.neckwearColor:o),c==="hoodie"&&e.ellipsoid([0,q(.25),-.37],[.58,.48,.26],o)}else if(A){let ie=de?u:_(I,d,.15);for(let x of[-1,1]){let fe=(U,te,K)=>ae(U,x*te,K),ge=[[0,.52,.91],[.065,.25,.89],[.14,.07,.75],[.2,.08,.64],[.34,.42,.43]];Lt(e,fe,ge,ie,.033),e.tube(ge.slice(1).map(([U,,te])=>fe(U,te,.045)),.009,_(ie,d,.65),{sides:7})}}if(c==="suit_tie"&&t.neckwear!=="bowtie"){let ie=ae;Lt(e,ie,[[.26,-.052,.052],[.88,-.115,.115],[1.14,-.115,.115],[1.23,-.004,.004]],d,.039),Lt(e,ie,[[.175,-.064,.064],[.212,-.105,.105],[.3,-.056,.056]],_(d,"#352738",.13),.054)}else if(t.neckwear==="bowtie"||c==="blouse"&&t.neckwear==="none"){let ie=ae(.23,0,.04);wi(e,...ie,.26,t.neckwear==="bowtie"?t.neckwearColor:d)}else if(["necklace","pendant","pearls","lanyard","choker"].includes(t.neckwear)){let ie=t.neckwearColor;if(t.neckwear==="choker")e.loft([[Re+.115,Y*1.01,Y*.97],[Re+.19,Y,Y*.97]],ie);else{let x=t.neckwear==="lanyard",fe=[];for(let ge=0;ge<=24;ge++){let U=ge*Math.PI*2/24,te=(Math.cos(U)+1)/2,K=Re+.11-te*(x?.84:.38),ne=Math.sin(U)*Y*1.42,he=(n-K)/i,Z=f.section(he)[0],j=Math.cos(U)*(Y+.04),me=Math.asin(Math.min(.999,Math.abs(ne/Z))),ke=(v(me)>he?f.ring:$)(he,me,.026)[2];fe.push([ne,K,K<=Re&&Math.cos(U)>0?Math.max(j,ke):j])}if(e.tube(fe,x?.037:.015,ie),t.neckwear==="pearls")for(let ge of fe.slice(0,-1))e.ellipsoid(ge,[.029,.029,.029],ie,{sides:8,rings:5});else e.ellipsoid(fe[0],[x?.13:.047,x?.18:.08,.027],ie)}}if(t.nameBadge||t.brooch&&t.brooch!=="none"){let ie=c==="apron"?.16:c==="cyber"?.09:.025,x=(fe,ge,U)=>ve(fe,ge,U+ie);if(t.nameBadge&&c!=="apron"&&c!=="cyber"&&Lt(e,x,[[.52,.4,.65],[.54,.37,.68],[.6,.37,.68],[.62,.4,.65]],d,.02),t.brooch&&t.brooch!=="none"){let fe={heart:12,star:10,flower:16,round:16}[t.brooch]||16,ge=Array.from({length:fe},(U,te)=>{let K=Math.PI*2*te/fe;if(t.brooch==="heart")return x(.58-.006*(13*Math.cos(K)-5*Math.cos(2*K)-2*Math.cos(3*K)-Math.cos(4*K)),-.59+.09*Math.sin(K)**3,.03);let ne=te%2===0||t.brooch==="round"?.1:t.brooch==="star"?.047:.076;return x(.58-ne*Math.cos(K),-.59+ne*Math.sin(K),.03)});e.mesh([x(.58,-.59,.063),...ge],ge.map((U,te)=>[0,te+1,(te+1)%fe+1]),t.broochColor)}}a(e,t,{hip:r,leg:l,floor:p,waist:y,hips:w,hipDepth:k,y:q,shapeContour:f.shapeContour,dress:M,finish:M?ee:V[h.bottomFabric]||0})}function Ie(e,t,a,s,n,r=!1,i=null){let l=[],p=[],h=i?[]:void 0,c=typeof n=="function"?[]:null;for(let d=0;d<=a;d++)for(let u=0;u<=t;u++){let m=u/t,g=d/a,f=s(m,g);l.push(f),i&&h.push(i(m,g)),c&&c.push(n(m,g,f))}let o=t+1;for(let d=0;d<a;d++)for(let u=0;u<t;u++){let m=d*o+u,g=m+1,f=g+o,E=m+o;r?p.push([m,f,g],[m,E,f]):p.push([m,g,f],[m,f,E])}e.mesh(l,p,c??n,h)}function Wt(e,t,a,s,n){let r=[],i=[];for(let l=0;l<=t;l++){let p=l/t;r.push(a(p)),i.push(typeof s=="function"?s(p):s)}e.tube(r,i,n,{sides:6})}function Wo(e,t){let a=t.headWidth??1,s=t.headHeight??1,n=([r,i,l])=>[r*a,i*s,l];return{mesh:(r,i,l,p)=>e.mesh(r.map(n),i,l,p?.map(n)),tube:(r,i,l,p)=>e.tube(r.map(n),i,l,p),ellipsoid:(r,i,l,p)=>e.ellipsoid(n(r),n(i),l,p)}}var qe=Math.PI,Tt=2*qe,At=(e,t,a)=>e+(t-e)*a,Ks=(e,t,a)=>Math.max(t,Math.min(a,e)),fa=e=>Math.sin(Ks(e,0,1)*qe),Pt=(e,t,a=0)=>[(.599+a)*Math.sin(t)*Math.sin(e),(.785+a)*Math.cos(t)+.008,(.591+a)*Math.sin(t)*Math.cos(e)-.045];function ko(e){return 1.06+.99*(1-Math.cos(e))*.5+.16*Math.sin(e)**2}function so(e,t,a,s,n,r,i,l,p=0){let h=.13+.025*(l%3);function c(o,d,u=0){let m=d*(.28+.72*d),g=n*(.33+.67*Math.sin(d*qe*.77))*(1-Ks((d-.63)/.37,0,1)**1.28),f=t+a*m+o*g,E=At(h,s,d)+.018*Math.sin(d*qe)*o;return Pt(f,E,.025+(p+.0028*l)*fa(d)+.03*(1-o*o)*Math.sin(qe*d)**.6+u)}Ie(e,8,19,(o,d)=>c(o*2-1,d),r,!0),Ie(e,2,12,(o,d)=>{let u=.25+.025*(l%3)+.53*d,m=.13*fa(d)**.65*(1+.42*Math.sin(d*qe*2.1));return c(-.27+(2*o-1)*m,u,.0025)},i,!0)}function ki(e,t,a,s){if(["none","buzz","afro","curly_halo","mohawk"].includes(t.hairStyle))return;if(!(t.fringe&&!["swept","side_sweep","updo","updo_bun","quiff"].includes(t.hairStyle))){let i=[[-1.27,1.62],[-.91,1.31],[-.34,1.07],[.32,1.21],[.66,1.34],[.97,1.48],[1.27,1.64]];for(let[l,[p,h]]of i.entries()){let c=-.62+(l-2)*.115;so(e,c,p-c,h,.4,_(a,s,.046*(l%3)),_(a,s,.61),l,t.hairStyle==="quiff"?.091:.022)}return}let r=[1.51,1.36,1.29,1.45,1.28,1.36,1.54];for(let i=0;i<7;i++){let l=i/6,p=At(-1.18,1.18,l),h=p*.47-.41;so(e,h,p-h,r[i],.35,_(a,s,.02+.045*(i%3)),_(a,s,.58),i,.01)}}function Li(e,t,a,s,n){let r=["long_waves","wolf_shag","bob","half_up","side_braid"].includes(t),i=["bob","french_bob","sleek_bob"].includes(t),l=i?.91:.99,p=i?8:10,h=.33;function c(o,d,u=0){let m=.15*Math.sin(qe*o*2+.5),g=At(l,Tt-l,o)+.6*m*(1-d)**2,f=Math.cos(Tt*p*o+(r?.69*Math.sin(5*d):0));if(d<h){let q=.002+1.378*d/h;return Pt(g,q,.018+.014*f*Math.sin(q)+u)}let E=Pt(g,1.38,.018);d=(d-h)/(1-h);let y=Math.sin(g),w=r?.072*d*Math.sin(8*d+g*2):0,k=.014*f,Y=.044*Math.sin(qe*d)**.64+(i?.048*Math.sin(qe*d)-.068*d**4:.076*d+.027*Math.sin(qe*d)),C=.057*d-.097*d**2;return[E[0]+y*(Y+w+k+u),E[1]-a*d+(.049*Math.cos(Tt*p*o)+.073*Math.sin(Tt*3*o-.5))*d**4+.16*d**3*(1-y*y),E[2]+Math.cos(g)*(C+w+k+u)-.036*d]}Ie(e,64,29,(o,d)=>c(o,d),s,!0),Ie(e,42,14,(o,d)=>c(o,d,-.041),_(s,"#24182b",.34)),Ie(e,72,2,(o,d)=>c(o,1,-.041*d),_(s,"#24182b",.29),!0);for(let o=0;o<p;o++)Ie(e,4,25,(d,u)=>{let m=.049+.89*u,g=(o+.21+(r?.15*Math.sin(5*m):0))/p;return c(g+(2*d-1)*.015*fa(u)**.7,m,.004)},_(s,n,.36+o%3*.07),!0)}function ro(e,t,a,s,n,r,i,l=!1){function p(h,c,o=0){let[d,u,m]=t(c),g=typeof a=="function"?a(c):a,E=(l?.04+.96*Math.min(1,c/.19)**.68:1)*(.68+.32*Math.sin(qe*c))*(1-.98*c**2.5),y=Math.cos(h)*s*E,w=(n*E+o)*Math.sin(h);return[d+Math.cos(g)*y+Math.sin(g)*w,u,m-Math.sin(g)*y+Math.cos(g)*w]}Ie(e,12,19,(h,c)=>p(Tt*h,c),r),Ie(e,3,12,(h,c)=>p(1.37+(2*h-1)*.23*fa(c),.1+.71*c,.004),i)}function vi(e,t,a){function n(i,l,p=0){let h=At(.96,Tt-.96,i),c=Math.sin(2*qe*i),o=Tt*9*i+.69*Math.sin(3*Tt*i);if(l<=.32){let Y=At(.004,1.39,l/.32);return Pt(h,Y,.019+.013*Math.cos(o)*Math.sin(Y)+p)}let d=(l-.32)/.68,u=Pt(h,1.39,.019),m=Math.sin(2.3*qe*d-.58+.55*Math.sin(h*2)),g=.078*Math.sin(qe*d)+.12*d**1.32*m-.032*d**3,f=(.013+.005*d)*Math.cos(o+1.28*d*m),E=(.52*Math.cos(qe*i)+.1*c*m)*d**1.28,y=h+E,w=1.52-.3*Math.abs(Math.cos(qe*i))**6,k=(.038+.014*Math.cos(Tt*3*i))*Math.cos(o)+.047*Math.sin(qe*5*i);return[((.599+.019+f+p)*Math.sin(1.39)+g)*Math.sin(y),u[1]-w*d-k*d**4,((.591+.019+f+p)*Math.sin(1.39)+.7*g)*Math.cos(y)-.045-.066*d]}Ie(e,86,42,(i,l)=>n(i,l),t,!0);let r=_(t,"#24182b",.33);Ie(e,72,27,(i,l)=>n(i,l,-.029),r),Ie(e,86,2,(i,l)=>n(i,1,-.029*l),r,!0);for(let i of[0,1])Ie(e,2,29,(l,p)=>n(i,p,-.029*l),r,i===0);for(let i=0;i<9;i++){let l=.06+.043*(i%3);Ie(e,4,34,(p,h)=>{let c=At(l,.925-.021*(i%2),h),o=Math.max(0,(c-.32)/.68),d=(i+.53-.26*o*Math.sin(2.3*qe*o+i*.71))/9,u=.01*fa(h)**.65*(1+.29*Math.sin(9.2*h+.6*i));return n(d+(2*p-1)*u,c,.003)},_(t,a,.31+i%3*.055),!0)}for(let i of[-1,1])for(let[l,[p,h,c,o,d]]of[[.94,1.04,1.16,.095,-.65],[1.15,1.12,1.47,.132,.47],[1.48,1.15,1.56,.133,1.35]].entries()){let u=i*p,m=Pt(u,h,.022),g=E=>2.18*qe*E+d+.2*i;ro(e,E=>{let y=Math.sin(g(E))*E**.77;return[m[0]+i*(.11*fa(E)+.075*E+(.093+.014*l)*y),m[1]-c*E+.026*y,m[2]+.068*fa(E)-(.014+l*.061)*E+.062*E*Math.cos(g(E))]},E=>u+i*.62*Math.sin(g(E)),o,.058,_(t,a,.05+l*.04),_(t,a,.54-l*.04),!0)}}function Yi(e,t,a,s){let n=t.hairStyle,r=.64;["long_waves","long_straight","half_up","twin_ringlets","side_braid","wolf_shag"].includes(n)&&(r=1.45),["french_bob","bob","sleek_bob","shoulder_lob"].includes(n)&&(r=n==="shoulder_lob"?1.29:.88),["pixie","swept","side_sweep","quiff","mohawk"].includes(n)&&(r=.48);let i=["long_waves","wolf_shag","twin_ringlets","bob","half_up"].includes(n);for(let l of[-1,1])for(let p=0;p<2;p++){let h=l*(.89+p*.255),c=r*(p===0?.89:1),o=Pt(h,1.045+.075*p,.027);ro(e,u=>{let m=l*(.084*Math.sin(qe*u)+.041*u+(i?.048*u*Math.sin(7*u+p):0));return[o[0]+m,o[1]-c*u,o[2]-.054*u+.019*Math.sin(qe*u*2+p*.6)]},h,.112+(i?.015:0),.061,_(a,s,.04+p*.08),_(a,s,.6),!0)}}function Fs(e,t,a,s,n=0,r=!1){let i=n?[n*.5,.32,-.23]:[0,r?-.17:.475,-.485],l=n?n*1.8:qe,p=n?1.45:r?1.16:1.56;e.ellipsoid(i,[.148,.13,.142],t.outfitAccent||s);for(let h=-1;h<=1;h++)ro(e,o=>{let d=Math.sin(qe*o);return[i[0]+(n?n*(.25*d+.07*o):.205*Math.sin(4.9*o)*o)+h*(.066+.041*d),i[1]-o*p+.19*d,i[2]-.29*Math.sin(o*qe*.74)-.11*o+.049*Math.cos(h*2)]},l+.23*h,.135,.098,_(a,s,(h+1)*.052),_(a,s,.5))}function Ui(e,t,a,s,n){for(let i=0;i<7;i++){let l=t*(.499+.048*Math.sin(i*.65)),p=-.08-i*.133,h=.128-.009*i;for(let c of[-1,1])e.ellipsoid([l+.033*c,p+.031*c,-.075+.047*i],[h*.65,h*1.24,h*.75],_(a,s,.075*(c+1)),{rotation:[0,0,c*.51]})}e.ellipsoid([t*.463,-.965,.225],[.072,.035,.072],n),ro(e,i=>[t*(.463+.052*i),-.98-.2*i,.225+.02*i],t,.078,.051,a,s)}function Vs(e,t){let a=t.hairStyle||"long_waves",s=t.hairColor||"#483248",n=t.hairHighlight||_(s,"#ffdde3",.38);if(a==="none")return;let r=["afro","curly_halo"].includes(a),i=a==="mohawk",l={long_waves:1.66,long_straight:1.64,half_up:1.58,wolf_shag:1.24,shoulder_lob:1.2,bob:.88,french_bob:.77,sleek_bob:.83,side_braid:.78,twin_ringlets:1.36},p=_(s,"#211527",.12),h=l[a]?1.08:qe;if(Ie(e,l[a]?28:64,25,(c,o)=>{let d=(2*c-1)*h,m=.001+(ko(d)-.001)*o;return Pt(d,m,i?-.012:.012)},p,!0),a==="taper_crop"||a==="side_part"){let c=a==="side_part";for(let o=0;o<16;o++){let d=At(1.04,Tt-1.04,o/15);so(e,d-.28,.28,ko(d)+.055,.25,s,_(s,n,.29),o%4)}for(let o=0;o<10;o++){let d=At(-1.3,1.3,o/9),u=c?d<-.72?-1.09:-.77+.13*d:.47*d-.32,m=(c?1.1:1.16)+.22*Math.abs(d)+(c?0:.14*Math.sin(o*3.7));so(e,u,d-u,m+(t.fringe?.13:0),c?.39:.34,_(s,n,.055*(o%3)),_(s,n,.62),o,c?.052:.095)}return}if(r){let c=a==="afro"?1.13:.94;for(let o=0;o<4;o++){let d=[5,10,15,18][o];for(let u=0;u<d;u++){let m=Tt*(u+o%2*.5)/d,g=.2+(ko(m)-.19)*o/3,[f,E,y]=Pt(m,g,.045*c),w=(.132+.015*Math.sin(14*m+o))*c;e.ellipsoid([f,E+.031,y],[w*1.19,w,w*1.07],_(s,n,.08*((u+o)%3)))}}return}if(i){for(let c=0;c<7;c++){let o=1-c*.28,d=Pt(0,o,.003);e.tube([d,[0,d[1]+.082,d[2]-.03],[0,d[1]+.22,d[2]-.14]],[[.114,.086],[.09,.077],.003],_(s,n,.08*(c%3)))}return}a==="long_waves"?vi(e,s,n):l[a]&&Li(e,a,l[a],s,n);for(let c=0;!l[a]&&c<10;c++){let o=At(1.25,Tt-1.25,c/9),d=ko(o);so(e,o-.19,.19,d+.08,.31,_(s,n,.04+c%3*.04),_(s,n,.44),c)}if(ki(e,t,s,n),a!=="long_waves"&&Yi(e,t,s,n),(a==="ponytail"||a==="low_ponytail"||a==="half_up")&&Fs(e,t,s,n,0,a==="low_ponytail"),a==="pigtails"||a==="twin_ringlets")for(let c of[-1,1])Fs(e,t,s,n,c);if(a==="braids"||a==="side_braid")for(let c of a==="braids"?[-1,1]:[1])Ui(e,c,s,n,t.outfitAccent||n);if(["updo","updo_bun","space_buns"].includes(a))for(let c of a==="space_buns"?[-1,1]:[0]){let o=c*.49,d=c?.58:.7,u=c?-.224:-.29;e.ellipsoid([o,d,u],[.214,.206,.218],s);for(let m=0;m<3;m++)Wt(e,22,g=>{let f=g*qe,E=(m-1)*.57+.25;return[o+.21*Math.cos(f)*Math.cos(E),d+.203*Math.sin(f),u+.218*Math.cos(f)*Math.sin(E)]},g=>.003+.009*fa(g),_(s,n,.41))}}function zs(e,t){let a=t.headwear,s=t.headwearColor||"#c75f87";if(!a||a==="none")return;let n=_(s,"#fff2de",.4),r=_(s,"#311f37",.27);if(["headband","headphones","cat_ears","tiara"].includes(a)){Wt(e,32,i=>{let l=(i-.5)*qe*1.065;return[.604*Math.sin(l),.786*Math.cos(l)+.01,.015+.12*Math.cos(l)]},a==="tiara"?.017:.036,s);for(let i of[-1,1])if(a==="headphones"&&(e.ellipsoid([i*.582,-.017,.005],[.093,.181,.144],r),e.ellipsoid([i*.643,-.017,.009],[.054,.147,.117],s)),a==="cat_ears"){let l=[[i*.245,.67,-.069],[i*.581,.463,-.061],[i*.514,.995,-.076],[i*.42,.649,.131]];e.mesh(l,[[0,1,2],[0,2,3],[1,3,2],[0,3,1]],s),e.mesh([[i*.32,.68,.016],[i*.545,.552,.003],[i*.496,.926,-.041]],[[0,1,2]],_(s,"#fad0db",.6))}if(a==="tiara")for(let i=-2;i<=2;i++){let l=.122-.027*Math.abs(i),p=i*.111,h=.632-.034*Math.abs(i),c=.329-.024*Math.abs(i);e.tube([[p-.083,h-.014,c],[p,h+l,c],[p+.083,h-.014,c]],[.012,.016,.012],n),e.ellipsoid([p,h+l,c],[.023,.031,.021],i?n:"#dca0ae")}}else if(a==="bow"||a==="flower")if(a==="bow"){for(let i of[-1,1])e.ellipsoid([.369+i*.106,.584+i*.034,.311],[.133,.08,.044],s,{rotation:[0,0,i*.37]}),e.tube([[.369,.584,.297],[.369+i*.058,.469,.321],[.369+i*.115,.391,.313]],[[.04,.018],[.051,.018],[.035,.012]],r);e.ellipsoid([.369,.584,.353],[.053,.059,.032],n)}else{for(let i=0;i<6;i++){let l=Tt*i/6;e.ellipsoid([.467+.066*Math.cos(l),.428+.066*Math.sin(l),.261],[.067,.054,.039],i%2?s:n)}e.ellipsoid([.467,.428,.295],[.041,.04,.029],"#f5d891")}else if(a==="headscarf")Ie(e,50,18,(i,l)=>{let p=(i-.5)*Tt;return Pt(p,.002+l*(1.09+1.43*(1-Math.cos(p))*.5),.076)},s,!0),ro(e,i=>[.22+.08*i,-.26-.78*i,-.448-.05*i],2.6,.18,.066,s,n);else if(a==="beret"){let i=(p,h,c,o,d=0)=>{let u=(p-.5)*Tt,m=h*Math.sin(u)+d;return[m,o+m*.105,-.045+c*Math.cos(u)]};Ie(e,48,2,(p,h)=>i(p,At(.475,.605,h),At(.485,.62,h),At(.447,.432,h)),r,!0),Ie(e,48,4,(p,h)=>i(p,At(.605,.574,h),At(.62,.583,h),At(.432,.535,h)),r);let l=[[.51,.574,.583,0],[.531,.635,.614,-.023],[.581,.684,.628,-.052],[.662,.666,.617,-.069],[.76,.6,.552,-.076],[.846,.461,.448,-.073],[.903,.292,.315,-.07],[.925,.135,.157,-.072],[.928,0,0,-.075]];Ie(e,48,l.length-1,(p,h)=>{let[c,o,d,u]=l[Math.round(h*(l.length-1))];return i(p,o,d,c,u)},s),e.ellipsoid([-.078,.937,-.044],[.027,.031,.028],r)}else{let i=a==="chef",l=a==="fedora",p=a==="cap";if(e.ellipsoid([0,i?.8:.59,-.042],[i?.62:.555,i?.34:.29,.539],s),e.ellipsoid([0,.526,-.027],[.564,.095,.528],r),(p||l)&&e.ellipsoid([0,.493,p?.335:-.025],[l?.692:.47,.043,l?.636:.366],s,{rotation:[.042,0,0]}),a==="beanie"&&e.ellipsoid([0,.881,-.065],[.08,.077,.08],n),i)for(let h of[-1,0,1])e.ellipsoid([h*.28,.949,-.061],[.28,.233,.37],s)}}var Se=Math.PI,qs="#342332",sa=(e,t,a)=>Math.max(t,Math.min(a,e)),ra=(e,t,a)=>e+(t-e)*a,na=e=>Math.exp(-e*e);function io(e,t,a){let s=sa((a-e)/(t-e),0,1);return s*s*(3-2*s)}function Sn(e){let t=e.genderStyle==="masculine"?1:e.genderStyle==="neutral"?.45:0,a=e.cheekboneWidth??1,s=(e.jawWidth??.9)*(1+.105*t),n=-.695-.15*(e.chinLength??0)-.022*t,r=e.chinRoundness??.65,i=[[n,.012,.018,.14],[n+.044,.13+.045*r+.039*t,.135,.125],[-.54,.288*s,.298,.075],[-.39,.424*s,.414,.02],[-.2,.49*a,.479,.003],[.02,.525*a,.5,-.024],[.22,.535,.509,-.038],[.41,.491,.472,-.052],[.57,.389,.398,-.057],[.67,.22,.256,-.064],[.712,.012,.018,-.066]];function l(d){let u=0;for(;u<i.length-2&&d>i[u+1][0];)u++;let m=i[u],g=i[u+1],f=i[Math.max(0,u-1)],E=i[Math.min(i.length-1,u+2)],y=g[0]-m[0],w=sa((d-m[0])/y,0,1),k=w*w,Y=k*w;return[1,2,3].map(C=>(2*Y-3*k+1)*m[C]+(Y-2*k+w)*y*(g[C]-f[C])/(g[0]-f[0])+(3*k-2*Y)*g[C]+(Y-k)*y*(E[C]-m[C])/(E[0]-m[0]))}let p=-.205-.2*((e.noseLength??1)-1),h=.079*(e.noseWidth??1);function c(d,u){let m=d/h,g=(u-p)/.078,f=(u-p-.07)/.138,E=(.082+.012*t)*Math.exp(-m*m-g*g)+.041*Math.exp(-1.7*m*m-f*f),y=(u+.367)/.077,w=(u-(n+.145))/.085,k=(u+.346)/.03,Y=(u+.397)/.027,C=.024*Math.exp(-y*y)+.024*Math.exp(-k*k)+.025*Math.exp(-Y*Y);return E+C*Math.exp(-((d/.136)**2))+.059*Math.exp(-((d/.177)**2)-w*w)}function o(d,u,m=0){let[g,f,E]=l(u),y=Math.sqrt(Math.max(0,1-(d/g)**2));return[d,u,E+(f+c(d,u))*y+m]}return{chinY:n,noseY:p,noseWidth:h,section:l,relief:c,at:o}}function In(e,t,a,s,n,r,i,l,p=0){Ie(e,20,3,(h,c)=>{let o=h*2*Se,d=n*Math.cos(o)*c;return t.at(a+d,s+Math.sin(o)*r*c+d*p,i)},l,!0)}function Ci(e,t,a){let s=t.earSize??1;for(let n of[-1,1]){let r=n*(.494+.024*s),i=t.earStyle;if(i==="pointed"?e.tube([[n*.471,-.16,-.014],[r,.007,-.023],[n*(.52+.16*s),.12*s,-.11]],[[.06,.065],[.09*s,.08*s],.004],a,{sides:14}):e.ellipsoid([r,-.077,-.044],[.101*s,.155*s,.087*s],i==="cyber"?"#8091a3":a,{rotation:[0,0,-n*.19]}),e.ellipsoid([r+n*.026,-.077,.026*s],[.045*s,.078*s,.021],i==="cyber"?"#72edf3":_(a,"#ab686a",.32),{rotation:[0,0,-n*.18]}),t.earrings&&t.earrings!=="none"){let l=r+n*.03,p=-.083-.13*s,h=t.earringColor||"#e8be7e";if(e.ellipsoid([l,p,.042],[.026,.026,.024],h),t.earrings==="hoops")Wt(e,22,c=>[l+.06*Math.sin(2*Se*c),p-.071+.074*Math.cos(2*Se*c),.045],.01,h);else if(t.earrings==="drops"||t.earrings==="hearts")if(Wt(e,3,c=>[l,p-.087*c,.041],.0075,h),t.earrings==="hearts")for(let c of[-1,1])e.ellipsoid([l+c*.016,p-.101,.042],[.025,.041,.014],h,{rotation:[0,0,-c*.55]});else e.ellipsoid([l,p-.115,.042],[.029,.055,.023],h)}}}function Di(e,t,a,s){for(let n of[-1,1]){if(t.freckles>0){let r=[[.31,-.159],[.345,-.137],[.273,-.15],[.24,-.173],[.38,-.172],[.16,-.16],[.101,-.171],[.303,-.195],[.361,-.152],[.227,-.139]];for(let[i,l]of r.slice(0,Math.ceil(r.length*t.freckles)))In(e,a,n*i,l+n*.003,.006,.0045,.0065,_(s,"#6b3842",.26+.4*t.freckles))}if(t.dimples>0||t.ageLines>0){let r=Math.max(t.dimples||0,t.ageLines||0);Wt(e,8,i=>a.at(n*(.172+.013*Math.sin(i*Se)),-.374+.044*i,.005),i=>.001+.0035*r*Math.sin(i*Se),_(s,"#995d63",r*.42))}t.ageLines>.1&&Wt(e,8,r=>a.at(n*(.374+.047*r),-.052-.016*r,.005),r=>.001+.003*t.ageLines*Math.sin(r*Se),_(s,"#925f65",t.ageLines*.5)),Wt(e,8,r=>a.at(n*a.noseWidth*(.45+.31*r),a.noseY-.037+.005*Math.sin(r*Se),.0028),r=>.001+.003*Math.sin(r*Se),_(s,"#974f58",.42))}if(Ie(e,16,5,(n,r)=>{let i=Math.sin(Se*n)**.8,l=a.noseWidth*(.38+.21*n+(r-.5)*.39*i),p=a.noseY+.073-.105*n;return a.at(l,p,.0038)},_(s,"#ab6973",.23)),Ie(e,10,3,(n,r)=>{let i=a.noseWidth*(n*.74-.13),l=a.noseY-.028+.017*n*n;return a.at(i,l+.01*r*Math.sin(Se*n),.005)},_(s,"#ac626a",.43)),In(e,a,-.19*a.noseWidth,a.noseY+.008,.014,.006,.004,_(s,"#fff0dc",.55),.16),t.beautyMark&&In(e,a,.305,-.245,.011,.009,.005,"#69424c"),t.noseStud&&e.ellipsoid(a.at(-a.noseWidth*.7,a.noseY-.005,.007),[.012,.011,.012],t.earringColor||"#f9e5b2"),t.facialHair&&t.facialHair!=="none"){let n=_(t.hairColor||"#332532",s,.16),r=t.facialHair==="boxed_beard";if(["beard","goatee","boxed_beard"].includes(t.facialHair)){let i=t.facialHair==="goatee",l=Ct(n),p=qt(l,Ct(s),.58);Ie(e,36,10,(h,c)=>{let o=Math.abs(2*h-1),d=(2*h-1)*(i?.65:1.73),u=-.47+.4*o**1.55+.039*na(o/.12)-.045*na((o-.19)/.13);i&&(u=-.465-.12*o),r&&(u=-.44+.32*o**1.15+.035*Math.sin(Se*o));let m=a.chinY+.004+.012*o,g=ra(m,u,c),[f,E,y]=a.section(g),w=.005+(r?.025:.022)*Math.sin(Se*c),k=(f+w)*Math.sin(d),Y=Math.cos(d);return[k,g,y+(E+w+.001+(Y>0?a.relief(k,g):0))*Y]},(h,c)=>qt(l,p,.78*io(.74,1,c)+.07*(1+Math.cos(37*h+2*c))))}if(t.facialHair!=="stubble")for(let i of[-1,1])Ie(e,15,3,(l,p)=>{if(r||t.facialHair==="chevron"){let c=i*(.001+.171*l),o=-.326-.047*l+.032*Math.sin(Se*l),d=(.024+.031*Math.sin(Se*l))*(1-l**5);return a.at(c,o+d*(p-.2),.013)}let h=(.42+.58*Math.sin(Se*l)**.6)*(1-l**3);return a.at(i*(.004+.155*l),-.342-.03*l+.018*Math.sin(Se*l)+.036*h*p,.009+.007*h*Math.sin(Se*p))},n,i<0)}}function Pi(e,t,a){let s=t.glasses,n=t.glassesColor||"#302938";if(!s||s==="none")return;if(s==="visor"){let h=(c,o,d=.078)=>{let u=(2*c-1)*.455,m=Math.abs(2*c-1),g=-.095+.074*m**3,f=.209-.083*m**4;return a.at(u,g+f*o,d)};for(let[c,o]of[[0,.12],[.88,1]])Ie(e,8,4,(d,u)=>h(ra(c,o,d),u),n);for(let c of[0,1])Wt(e,42,o=>h(o,c),c?.013:.007,_(n,"#baf3ff",c?.19:.52));for(let c of[-1,1]){let o=h(c<0?0:1,.56);e.tube([o,[c*.506,.022,.228],[c*.551,.02,-.052]],[.028,.034,.023],n)}return}let r=.195,i=.242*(t.eyeSpacing??1),l=(h,c,o=1)=>{let d=c*Se*2,u=Math.cos(d),m=Math.sin(d),g=["round","aviator","heart"].includes(s),f=Math.sign(u)*Math.abs(u)**(g?1:.66),E=Math.sign(m)*Math.abs(m)**(g?1:.63);s==="heart"&&(E-=.39*Math.exp(-15*f*f)*Math.max(0,E)),s==="cat_eye"&&(E+=.44*Math.max(f,0)**2),s==="aviator"&&(E-=.16*Math.max(0,f));let y=h*(i+f*r*o),w=.004+E*.134*o;return a.at(y,w,.079)};for(let h of[-1,1]){s==="shades"&&Ie(e,32,5,(o,d)=>l(h,o,d),_(n,"#54708c",.39),h>0),Wt(e,32,o=>l(h,o),s==="bold"?.019:.011,n);let c=l(h,0);e.tube([c,[h*.493,.057,.239],[h*.546,.055,-.049]],[.012,.014,.014],n)}let p=l(1,.5);Wt(e,10,h=>[p[0]*(2*h-1),p[1]+.024*Math.sin(Se*h),p[2]+.008*Math.sin(Se*h)],.01,n)}function $s(e){let t=Math.abs(e);return .32-.32*(1-Math.cos(e))+.075*na((t-.88)/.33)-.11*na((t-1.42)/.19)}function Lo(e,t,a,s,n=0){let[r,i,l]=e.section(a),p=(r+n)*Math.sin(t),h=Math.cos(t);return[p,a,l+(i+n+(h>0?e.relief(p,a)*s:0))*h]}function Gi(e,t,a,s){let n=[],r=[],i=[],l=qt(a,Ct("#302938"),.46);for(let p=0;p<28;p++){let h=-.23+p*.034,c=Math.round(t.section(h)[0]*131);for(let o=0;o<c;o++){let d=Math.sin(o*13.3+p*4.9),u=-Se+(o+.5+.29*d)*2*Se/c,m=h+.012*Math.cos(o*3.1+p*2.7),g=io(.025,.11,m-$s(u));if(!g)continue;let f=Math.min(.71,m+.028+.009*d),E=.035*Math.cos(u)+.025*d,y=n.length;n.push(Lo(t,u-.012,m,1,.004),Lo(t,u+.012,m,1,.004),Lo(t,u+E,f,1,.004)),r.push([y,y+1,y+2]);let w=qt(a,d<0?l:s,g*(.48+.35*Math.abs(d)));i.push(w,w,qt(w,a,.48))}}e.mesh(n,r,i)}function Xs(e,t){let a=Wo(e,t),s=Sn(t),n=_(t.skinColor||"#f1c6b0","#b5cde0",(t.synthFinish||0)*.28),r=Ct(n),i=Ct("#e77986"),l=Ct(t.hairColor||"#483248"),p=t.hairStyle==="buzz"&&t.headwear!=="headscarf",h=t.facialHair==="stubble",c=sa(t.blushIntensity??.24,0,1),o=(u,m,g)=>{let f=m<.48?ra(s.chinY,-.27,m/.48):ra(-.27,.712,(m-.48)/.52);return Lo(s,(u-.5)*2*Se,f,g)};if(Ie(a,64,60,(u,m)=>o(u,m,1),(u,m,[g,f])=>{let E=(u-.5)*2*Se,y=Math.abs(E),w=Math.max(0,Math.cos(E)),k=na((Math.abs(g)-.32)/.145)*na((f+.17)/.078),Y=qt(r,i,c*.64*k*w);if(h&&y<1.9){let C=y/1.9,q=-.455+.39*C**1.5+.024*na(C/.14),Q=(1-io(q-.07,q+.07,f))*(1-io(1.56,1.9,y)),de=na((f+.322)/.023)*na(g/.125)*w;Y=qt(Y,l,Math.max(Q*.26,de*.2))}if(p){let C=$s(E),q=.058+.038*Math.sin(E)**2;Y=qt(Y,l,io(C-.015,C+q,f))}return Y},!1,(u,m)=>o(u,m,.48)),Ci(a,t,n),Di(a,t,s,n),p?Gi(a,s,l,Ct(t.hairHighlight||"#dacbd5")):t.headwear!=="headscarf"&&(e.finish=5,Vs(a,t),e.finish=0),Pi(a,t,s),zs(a,t),t.headsetMic){let u=s.at(.222,-.392,.035);a.tube([[.548,-.066,.015],[.566,-.178,.178],s.at(.397,-.307,.046),u],[.014,.014,.012,.01],"#393240"),a.ellipsoid(u,[.044,.022,.023],"#352c37")}}var js={classic:[1,0,1,1,.84,.76],round:[.9,-.017,1.3,1.17,.59,.62],feline:[1.05,.058,.78,.87,1.05,.89],hooded:[1.01,-.012,.92,.64,.85,.63]};function _i(e,t,a,s,n){let r=t.genderStyle==="masculine",i=t.eyeSize??1,[l,p,h,c,o,d]=js[t.eyeShape]??js.classic,u=a.section(0)[0]*.93,m=Math.min(.15*i*l,u*.455),f=sa(.217*(t.eyeSpacing??1),m*1.055,u-m)-m,E=.021+(t.eyeTilt??.06)*.23+p,y=(1-n)*(1+.55*(t.eyeOpen??0))*(r?.76:.87),w=s===1&&t.irisColor2?t.irisColor2:t.irisColor||"#5892bd",k=_(qs,t.hairColor||qs,.16),Y=D=>{let M=Math.max(0,Math.sin(Se*D)),A=-.012+E*(D-.5)+.01*Math.sin(Se*D);return[A-.064*i*y*h*M**o,A+.085*i*y*c*M**d*(.86+.28*D)]},C=(D,M,A)=>{let I=f+2*m*D;return a.at(s*I,M,A+.012*Math.max(0,Math.sin(D*Se)))},q=(D,M)=>{let[A,I]=Y(D);return C(D,ra(A,I,M),.0115)};if(y>.04){let V=function(ee,v,P,X,oe){v+=M;let[$,ae]=Y(ee);v-X<=$||v+X>=ae||Ie(e,14,2,(ue,Ae)=>C(ee+Math.cos(2*Se*ue)*P*Ae,v+Math.sin(2*Se*ue)*X*Ae,.027),oe,s>0)};Ie(e,22,4,q,"#fff7f4",s<0);let D=.492+s*.14*(t.gazeX??0),M=-.038*(t.gazeY??0),A=.32,I=(ee,v,P,X,oe,$=!1)=>{Ie(e,22,4,(ae,ue)=>{let Ae=2*ae-1,we=D+v*Ae,[ye,Oe]=Y(we),ce=($?1-Math.abs(Ae):Math.sqrt(Math.max(0,1-Ae*Ae)))*P*i,ve=sa(X+M-ce,ye,Oe),Re=sa(X+M+ce,ye,Oe);return C(we,ra(ve,Re,ue),oe)},ee,s<0)};I(_(w,"#252239",.68),A,.121,.019,.0155),I(_(w,"#3c3d68",.17),A*.89,.106,.02,.0175),I(w,A*.83,.081,.007,.0195),I(_(w,"#fff0ae",.56),A*.75,.058,-.005,.021);let H=(ee,v,P)=>{let X=D+A*v*Math.cos(ee),[oe,$]=Y(X);return C(X,sa(.015+M+.114*i*v*Math.sin(ee),oe,$),P)};if(t.irisPattern==="halo")for(let[ee,v,P]of[[.76,.11,"#f6e5ab"],[.52,.055,"#c2f5ef"]])Ie(e,36,2,(X,oe)=>H(2*Se*X,ee+oe*v,.0223),_(w,P,.72),s>0);else if(t.irisPattern==="sunburst"||t.irisPattern==="prism"){let ee=t.irisPattern==="prism",v=ee?8:15;for(let P=0;P<v;P++){let X=(P+.22)*2*Se/v,oe=_(w,P%2?"#fbe2a4":"#b5f5fc",P%2?.65:.46);Ie(e,4,4,($,ae)=>{let ue=ee?.37*(1-ae):.055*Math.sin(Se*ae),Ae=X+(2*$-1)*ue;return H(Ae,ra(.33,P%3?.87:.76,ae),.0222)},oe,s>0)}}let W=t.irisPattern==="prism";I(_(w,"#24233a",.77),A*(W?.43:.49),.081,W?.018:.034,.0235,W),V(D-s*.082,.031,.071,.019,"#fffdf2"),V(D+s*.156,-.025,.038,.01,"#fff6e5"),V(D+s*.055,-.042,.023,.005,"#fff6e5")}if(t.eyeshadow>0){let D=_(t.skinColor||"#f1c6b0",t.eyeshadowColor||"#a06885",t.eyeshadow*.58);Ie(e,24,2,(M,A)=>{let[,I]=Y(M);return C(M,I+.009+.029*Math.sin(Se*M)*A,.006)},D,s<0)}t.eyeShape==="hooded"&&Ie(e,22,2,(D,M)=>{let A=.16+.7*D,[,I]=Y(A),H=Math.sin(Se*D);return C(A,I+.012+.023*H+.005*M*H,.009)},_(t.skinColor||"#f1c6b0",k,.28),s<0);let Q=t.lashStyle==="subtle"?.009:t.lashStyle==="lush"?.021:.016;Ie(e,30,2,(D,M)=>{let[,A]=Y(D),I=(Q+.008*(t.eyeliner||0))*(.2+Math.sin(Se*D*.88));return C(D,A+M*I-.003,.032)},k,s<0);for(let[D,M,A]of[[.88,.17,.014],[.78,.1,.028]])t.lashStyle==="subtle"&&D<.8||Ie(e,8,2,(I,H)=>{let W=D+M*I+(t.eyeliner||0)*.09*I,[,V]=Y(D);return C(W,V+A*I+.016*I*I+H*.017*(1-I),.033)},k,s<0);Ie(e,24,2,(D,M)=>{let A=.2+.8*D,[I]=Y(A);return C(A,I-M*(.001+.006*Math.sin(Se*D*.83)),.026)},_(k,t.skinColor||"#f1c6b0",.23),s>0);let de=t.browColor||_(t.hairColor||"#473344","#67404b",.25);Ie(e,24,3,(D,M)=>{let A=.085*(t.eyeSpacing??1)+D*m*1.66,I=.138+.038*(t.browLift??0)+.012*D+(.016+.074*(t.browArch??.22))*Math.sin(Se*D*.94)+.038*(t.browMood??0)*(.5-D);return a.at(s*A,I+(r?.034:.023)*(t.browThickness??1)*(.25+Math.sin(Se*D)**.6)*(M-.5),.009)},de,s<0)}var Ma=e=>Number.isFinite(e)?sa(e,0,1):0;function Bi(e,t,a,s,n){let r=Ma(n?.lipRound),i=Ma(n?.lipSpread),l=n?.labiodental===!0,p=l?Math.min(.68,Ma(n?.lipClose)):Ma(n?.lipClose),h=Ma(n?.tongueTip),c=Math.max(h,.75*Ma(n?.tongueHeight)),o=Math.max(l?.12:0,Math.min(1,s+.09*r)*(1-p)**1.25),d=.198*(t.mouthWidth??1)*(1-.41*r+.36*i),u=t.lipFullness??1,m=t.skinColor||"#f1c6b0",g=t.lipColor||"#d6687c",f=I=>-.368+(.011+.035*(t.restSmile??0))*(1-.62*r+.25*i)*Math.abs(2*I-1)**1.7,E=I=>Math.sin(Se*I)**(.75-.22*r),y=I=>E(I)*(.045*r+.003*p),w=t.facialHair&&t.facialHair!=="none"&&t.facialHair!=="stubble"?.029:.007,k=I=>f(I)+o*.06*E(I),Y=I=>f(I)-(.005*(1-p)+.097*o)*E(I),C=I=>k(I)+u*(.032+.012*r-.003*i-.005*Math.cos((I-.5)*Se*7))*E(I),q=I=>Y(I)-(l?.029:.044+.012*r)*u*E(I),Q=(I,H,W,V,ee)=>{let v=(2*I-1)*d,P=ra(W(I),V(I),H);return a.at(v,P,w+y(I)+E(I)*ee*Math.sin(Se*H)**.75)},de=(I,H,W)=>Q(I,H,k,C,W),D=(I,H,W)=>Q(I,H,q,Y,W),M=.016*u,A=.02*u;Ie(e,24,7,(I,H)=>de(I,H,M),_(g,"#55263a",.24),!1,(I,H)=>de(I,H,.004)),Ie(e,24,7,(I,H)=>D(I,H,A),_(g,m,.07),!1,(I,H)=>D(I,H,.004)),Ie(e,24,3,(I,H)=>a.at((2*I-1)*d,ra(Y(I),k(I),H),w+.001+y(I)),_(g,"#280e1b",.94)),(o>.16||l)&&Ie(e,20,2,(I,H)=>{let W=.105+.79*I,V=Math.min(.026+.01*i-.012*r,(k(W)-Y(W))*(l?.83:.39));return a.at((2*W-1)*d,k(W)-V*Math.sin(Se*I)**.45*H,w+.003+y(W))},"#f7e9df",!0),o>.16&&!l&&Ie(e,16,3,(I,H)=>{let W=.17+.66*I,V=o*(.031+.043*c)*Math.sin(Se*I);return a.at((2*W-1)*d,Y(W)+V*H,w+.003+y(W))},_(g,"#cb7b8c",.52)),Wt(e,12,I=>{let H=D(.34+I*.32,.46,A);return H[2]+=.002,H},I=>.001+.0023*Math.sin(Se*I),_(g,"#fff0e4",.63))}function Js(e,t,a=0,s=a){let n=Wo(e,t),r=Sn(t);for(let i of[-1,1])_i(n,t,r,i,sa(i===1?s:a,0,1))}function Qs(e,t,a,s){Bi(Wo(e,t),t,Sn(t),Ma(a??s?.jaw),s)}var vo=class{constructor(t,{floor:a,hip:s,shoulder:n,leg:r,length:i}){let l={confident:1.2,relaxed:1,presenter:.76,welcoming:.8}[t.posture]??.85;this.sections=[[a,0,0,-.19,0],[a+.6*r,.014,.007,-.16,.006],[s-1.62*r,.051,.026,-.19,.05],[s-.48*r,.093,.061,-.02,.02],[s+.35*i,.123,.083,.072,0],[n-1.5*i,.077,.028,.02,-.009],[n-.66*i,.008,-.025,-.035,0],[n,-.033,-.049,-.048,.009],[-.52*t.headScale,-.023,0,0,.014]].map(([p,...h])=>[p,...h.map(c=>c*l)]),this.values=new Float64Array(8)}sample(t){let a=this.sections,s=1;for(;s<a.length-1&&t>a[s][0];)s++;let n=a[s-1],r=a[s],i=r[0]-n[0],l=Math.max(0,Math.min(1,(t-n[0])/i)),p=l*l*(3-2*l),h=6*l*(1-l)/i;for(let c=0;c<4;c++){let o=r[c+1]-n[c+1];this.values[c]=n[c+1]+p*o,this.values[c+4]=h*o}return this.values}point([t,a,s]){let[n,r,i,l]=this.sample(a);return[t+n,a+r*t,s+i*t+l]}apply(t){let a=t.data,s=NaN;for(let n=0;n<a.length;n+=10){let r=a[n],i=a[n+1],l=a[n+3],p=a[n+4],h=a[n+5];i!==s&&(this.sample(i),s=i);let c=this.values;a[n]+=c[0],a[n+1]+=c[1]*r,a[n+2]+=c[2]*r+c[3];let o=(p-c[4]*(l-c[2]*h)-(c[6]*r+c[7])*h)/(1+c[5]*r-c[4]*c[1]),d=l-c[1]*o-c[2]*h,u=1/(Math.hypot(d,o,h)||1);a[n+3]=d*u,a[n+4]=o*u,a[n+5]=h*u}}};var lo=0,ga=1,Ba=2,Gt={arm:3,forearm:4,thigh:5,shin:6,hand:11,foot:13,knuckles:20,tips:21,thumb:22,index:23,indexTip:24},_t={arm:7,forearm:8,thigh:9,shin:10,hand:12,foot:14,knuckles:15,tips:16,thumb:17,index:18,indexTip:19},ho=25,er=Ba,Bt=Math.PI/180,tr=["left","right"],Zs=["rootX","rootY","rootZ","rootYaw","rootPitch","rootSway","torsoTurn","torsoLean","torsoPitch","headTurn","headTilt","headNod","plantFeet","groundFeet","thumbUp","leftThumbUp",...tr.flatMap(e=>["Shoulder","ArmLift","ArmRoll","Elbow","WristTurn","WristBend","Point","Hip","HipOut","HipTwist","Knee","AnkleFlex"].map(t=>e+t))],pt=(e,t,a)=>{let s=Math.max(0,Math.min(1,(a-e)/(t-e)));return s*s*(3-2*s)};function ia(e=0,t=0,a=0){let s=Math.cos(e*Bt),n=Math.sin(e*Bt),r=Math.cos(t*Bt),i=Math.sin(t*Bt),l=Math.cos(a*Bt),p=Math.sin(a*Bt);return[r*s,l*i*s+p*n,p*i*s-l*n,0,-i,l*r,p*r,0,r*n,l*i*n-p*s,p*i*n+l*s,0,0,0,0,1]}function xs(e,[t,a,s]){return e[12]=t-(e[0]*t+e[4]*a+e[8]*s),e[13]=a-(e[1]*t+e[5]*a+e[9]*s),e[14]=s-(e[2]*t+e[6]*a+e[10]*s),e}function co(e,t,a){let s=a*.88,n=Math.cos(s),r=Math.sin(s),i=Math.cos(t*Bt),l=Math.sin(t*Bt),p=1-i,h=a*e*Bt,c=Math.cos(h),o=Math.sin(h),d=n,u=-r,m=[i+d*d*p,u*l,d*u*p,0,-u*l,i,d*l,0,d*u*p,-d*l,i+u*u*p,0,0,0,0,1];for(let g=0;g<3;g++){let f=g*4,E=m[f],y=m[f+2];m[f]=c*E+o*y,m[f+2]=c*y-o*E}return m}function Fi(e,t,a,s){let n=16*a,r=16*t;for(let i=0;i<4;i++)for(let l=0;l<4;l++){let p=0;for(let h=0;h<4;h++)p+=e[n+h*4+l]*s[i*4+h];e[r+4*i+l]=p}}var Yo=class{constructor(t,a,s){this.bounds=a,this.shoulders=a.shoulders,this.hips=a.hips,this.reach=a.arm.reach,this.armY=a.arm.root,this.wristY=a.arm.wrist[1],this.handSize=t.handSize??1,this.neckY=-.56*t.headScale,this.stance=s,this.soles=[],this.pivots=[];let{shoulder:n,length:r,hip:i,leg:l}=a,{elbow:p,wrist:h}=a.arm,c=En(t,this.hips),o=c(-.2),d=c(1.62),u=c(3.3);this.pivots[ga]=s.point([0,n-1.57*r,0]),this.pivots[Ba]=s.point([0,this.neckY,-.035]);for(let m of[1,-1]){let g=m===1?Gt:_t;this.pivots[g.arm]=s.point([m*this.shoulders*.9,this.armY-.08*this.reach,0]),this.pivots[g.forearm]=s.point([m*p[0],p[1],p[2]]);let f=[m*h[0],h[1],h[2]];this.pivots[g.hand]=s.point(f);let E=(y,w,k)=>s.point(Tn(f,m,this.handSize,y,w,k));this.pivots[g.knuckles]=this.pivots[g.index]=E(0,-.195,.018),this.pivots[g.tips]=this.pivots[g.indexTip]=E(0,-.28,.025),this.pivots[g.thumb]=E(-.061,-.072,.006),this.pivots[g.thigh]=s.point([m*o.x,i+.2*r,o.z]),this.pivots[g.shin]=s.point([m*d.x,i-1.62*l,d.z]),this.pivots[g.foot]=s.point([m*u.x,i-3.3*l,u.z]);for(let y of[-.14,.38])this.soles.push({bone:g.foot,at:s.point([m*u.x,a.floor,y])})}this.palette=new Float32Array(16*ho),this.update({})}update(t){let a=Zs.map(l=>Number.isFinite(t?.[l])?t[l]:0),s=a.join("/");if(s===this.key)return;this.key=s,this.moving=a.some(l=>l!==0);let n=Object.fromEntries(Zs.map((l,p)=>[l,a[p]])),r=ia(n.rootYaw);if(n.rootPitch){let l=Math.cos(n.rootPitch*Bt),p=Math.sin(n.rootPitch*Bt);r[4]=r[8]*p,r[5]=l,r[6]=r[10]*p,r[8]*=l,r[9]=-p,r[10]*=l,xs(r,[0,this.bounds.hip,0])}r[12]+=n.rootX+r[0]*n.rootSway,r[13]+=n.rootY,r[14]+=n.rootZ+r[2]*n.rootSway,this.palette.set(r);let i=(l,p,h)=>Fi(this.palette,l,p,xs(h,this.pivots[l]));i(ga,lo,ia(n.torsoTurn,n.torsoLean,n.torsoPitch)),i(Ba,ga,ia(n.headTurn,n.headTilt,n.headNod));for(let l of tr){let p=l==="left"?1:-1,h=p===1?Gt:_t;i(h.arm,ga,ia(p*n[l+"ArmRoll"],p*n[l+"ArmLift"],-n[l+"Shoulder"])),i(h.forearm,h.arm,ia(0,0,-n[l+"Elbow"])),i(h.hand,h.forearm,co(n[l+"WristTurn"],n[l+"WristBend"],p));let c=p===1?n.leftThumbUp:n.thumbUp,o=n[l+"Point"],d=Math.max(c,o);i(h.knuckles,h.hand,co(0,77*d,p)),i(h.tips,h.knuckles,co(0,83*d,p)),i(h.index,h.hand,co(0,77*c,p)),i(h.indexTip,h.index,co(0,83*c,p)),i(h.thumb,h.hand,ia(0,0,-64*c+30*o)),i(h.thigh,lo,ia(p*n[l+"HipTwist"],p*n[l+"HipOut"],-n[l+"Hip"])),i(h.shin,h.thigh,ia(0,0,n[l+"Knee"])),i(h.foot,h.shin,ia(0,0,-n[l+"AnkleFlex"]))}if(n.plantFeet&&this.plantFeet(Math.min(1,Math.max(0,n.plantFeet))),n.groundFeet){let l=1/0;for(let{bone:h,at:[c,o,d]}of this.soles){let u=16*h+1;l=Math.min(l,this.palette[u]*c+this.palette[u+4]*o+this.palette[u+8]*d+this.palette[u+12])}let p=(this.bounds.floor+n.rootY-l)*Math.min(1,Math.max(0,n.groundFeet));for(let h=0;h<ho;h++)this.palette[h*16+13]+=p}}plantFeet(t){let a=this.palette;for(let s=0;s<3;s++){let n=0;for(let{foot:r}of[Gt,_t]){let[i,l,p]=this.pivots[r],h=r*16+s;n+=(a[s]-a[h])*i+(a[4+s]-a[h+4])*l+(a[8+s]-a[h+8])*p+a[12+s]-a[h+12]}n*=.5*t;for(let r=0;r<ho;r++)a[16*r+12+s]+=n}}bind(t){let a=t.data.length/10,s=new Float32Array(a*8),n=0,r=[[],[]];for(let i=0;i<a;i++){for(;n+1<t.parts.length&&t.parts[n+1].start<=i;)n++;let l=t.parts[n].name,p=i*10,h=t.data[p+1];this.bindVertex(s,i*8,l,t.data[p],h),l.endsWith("Leg")&&h<=this.bounds.floor+.027*this.bounds.leg&&r[l==="leftLeg"?0:1].push(this.stance.point([t.data[p],h,t.data[p+2]]))}if(r.every(i=>i.length)){this.soles=[];for(let[i,l]of r.entries())for(let p=0;p<8;p++){let h=p*Math.PI/4,c=Math.sin(h),o=Math.cos(h),d=l.reduce((u,m)=>m[0]*c+m[2]*o>u[0]*c+u[2]*o?m:u);this.soles.push({bone:i===0?Gt.foot:_t.foot,at:d})}}return s}bindVertex(t,a,s,n,r){let{hip:i,leg:l,shoulder:p,length:h}=this.bounds,c=(i-r)/l,o=(u,m,g)=>{t[a]=u,t[a+1]=m,t[a+4]=1-g,t[a+5]=g};if(s==="head"){o(Ba,Ba,0);return}if(s.endsWith("Thumb")||s.endsWith("Index")||s.endsWith("Fingers")){let u=s.startsWith("left")?Gt:_t,m=s.endsWith("Index"),g=m?u.index:u.knuckles,f=m?u.indexTip:u.tips,E=(this.wristY-r)/this.handSize;s.endsWith("Thumb")?o(u.hand,u.thumb,pt(.072,.13,E)):E<.225?o(u.hand,g,pt(.18,.225,E)):o(g,f,pt(.255,.303,E));return}if(s==="skirt"||s==="torso"&&r<p-1.74*h){let u=pt(-.7*this.hips,.7*this.hips,n),m=pt(-.68,.44,c),g=pt(1.39,1.86,c);g===0?t.set([lo,Gt.thigh,_t.thigh,0,1-m,m*u,m*(1-u),0],a):t.set([Gt.thigh,_t.thigh,Gt.shin,_t.shin,(1-g)*u,(1-g)*(1-u),g*u,g*(1-u)],a);return}if(s.endsWith("Leg")){let u=s==="leftLeg"?Gt:_t;if(c>3.1){o(u.shin,u.foot,pt(3.1,3.43,c));return}let m=pt(1.44,1.81,c);if(m>0)o(u.thigh,u.shin,m);else{let g=Math.min(1,pt(0,.25*this.hips,Math.abs(n))+pt(-.05,.32,c));o(lo,u.thigh,pt(-.68,.34,c)*g)}return}let d=pt(.65,.99,Math.abs(n)/this.shoulders)*(1-pt(.15,.75,(p-r)/h));if(s.endsWith("Arm")){let u=s==="leftArm"?Gt:_t,m=(this.armY-r)/this.reach,g=pt(1.1,1.46,m);r<this.wristY+.1*this.reach?o(u.forearm,u.hand,pt(-.1,.08,(this.wristY-r)/this.reach)):g>0?o(u.arm,u.forearm,g):o(ga,u.arm,d+(1-d)*pt(.03,.34,m));return}r>p?o(ga,Ba,pt(p,this.neckY,r)):d>0?o(ga,n>0?Gt.arm:_t.arm,d):o(lo,ga,pt(-1.95,-1.08,(r-p)/h))}};var Ki=`
attribute vec3 position, normal, pigment;
attribute float material;
attribute vec4 joints, weights;
uniform mat4 bones[${ho}];
uniform bool moving;
uniform vec2 orbit, fit;
uniform vec2 outlineOffset;
uniform vec2 focus;
varying vec3 ink, surface;
varying vec2 weave;
varying float finish;
vec3 toView(vec3 p) {
  float c = cos(orbit.x), s = sin(orbit.x), cp = cos(orbit.y), sp = sin(orbit.y);
  float depth = p.x*s + p.z*c;
  return vec3(p.x*c - p.z*s, p.y*cp - depth*sp, p.y*sp + depth*cp);
}
void main() {
  vec3 world=position, direction=normal;
  if (moving) {
    mat4 skin=weights.x*bones[int(joints.x)]+weights.y*bones[int(joints.y)]
      +weights.z*bones[int(joints.z)]+weights.w*bones[int(joints.w)];
    world=(skin*vec4(position,1.)).xyz;
    // Blended rotations can shear at a flexed joint. The cofactor matrix is
    // proportional to the inverse transpose and preserves the surface normal.
    mat3 basis=mat3(skin);
    vec3 corrected=mat3(cross(basis[1],basis[2]),cross(basis[2],basis[0]),cross(basis[0],basis[1]))*normal;
    direction=dot(corrected,corrected)>.000001 ? normalize(corrected) : basis*normal;
  }
  vec3 point = toView(world - vec3(0., focus.y, 0.));
  point.x -= focus.x;
  surface = toView(direction);
  vec2 edge = surface.xy / max(length(surface.xy), .15);
  gl_Position = vec4(point.xy*fit + edge*outlineOffset, -point.z/18., 1.);
  ink = pigment;
  weave = position.xy;
  finish = material;
}`,Vi=`
precision mediump float;
varying vec3 ink, surface;
varying vec2 weave;
varying float finish;
uniform bool outline;
uniform float clothDetail;
void main() {
  if (outline) {
    gl_FragColor = vec4(mix(vec3(.14,.09,.14),ink,.36),1.);
    return;
  }
  vec3 n = normalize(surface);
  if (!gl_FrontFacing) n = -n;
  float light = dot(n, vec3(-.43,.55,.71));
  // Retain a painted shadow edge over a continuous falloff. The broad key
  // describes the cheek and the narrower cool fill separates a dark sleeve.
  float lit = .77*smoothstep(-.48,.88,light) + .23*smoothstep(.04,.20,light);
  float highlight = smoothstep(.60,1.,light);
  vec3 shadow = ink * vec3(.71,.65,.76);
  vec3 color = mix(shadow,ink,lit) + highlight * (1.-ink)*vec3(.080,.073,.065);
  float fill = smoothstep(.25,.91,dot(n,vec3(.82,.35,-.44)));
  color += vec3(.043,.049,.069)*fill*(1.-ink);
  if (finish > .5 && finish < 1.5) {
    color *= 1. - clothDetail*.015*(1.-cos(weave.x*145.));
  } else if (finish > 1.5 && finish < 2.5) {
    float shine = smoothstep(.77,.88,dot(n,vec3(-.28,.31,.91)));
    color = mix(color,vec3(1.,.96,.98),shine*.27);
  } else if (finish > 2.5 && finish < 3.5) {
    color = mix(color*.92,vec3(.91,.82,.89),pow(1.-abs(n.z),3.)*.28);
  } else if (finish > 3.5 && finish < 4.5) {
    color *= 1. - clothDetail*.024*(1.-cos((weave.x+weave.y)*179.));
  } else if (finish > 4.5) {
    float sheen = smoothstep(.56,.95,dot(n,vec3(-.44,.62,.65)));
    color += vec3(.057,.048,.055)*sheen*(1.-ink);
  }
  float rim = 1. - smoothstep(.01,.13,abs(n.z));
  gl_FragColor = vec4(color*(1.-.20*rim),1.);
}`,zi={front:0,portrait:Math.PI/11,"three-quarter":Math.PI/4,profile:Math.PI/2,right:Math.PI/2,left:-Math.PI/2,back:Math.PI},Ea=(e,t,a)=>Math.max(t,Math.min(a,e)),Fa=(e,t)=>Number.isFinite(e)?Math.round(Ea(e,0,1)*t)/t:0,Ka=e=>Number.isFinite(e)?Math.round(Ea(e,-1,1)*8)/8:0;function qi(e){let t=e.createProgram(),a=[];try{for(let[s,n]of[[e.VERTEX_SHADER,Ki],[e.FRAGMENT_SHADER,Vi]]){let r=e.createShader(s);if(a.push(r),e.shaderSource(r,n),e.compileShader(r),!e.getShaderParameter(r,e.COMPILE_STATUS))throw new Error(e.getShaderInfoLog(r));e.attachShader(t,r)}if(e.linkProgram(t),!e.getProgramParameter(t,e.LINK_STATUS))throw new Error(e.getProgramInfoLog(t));return t}catch(s){throw e.deleteProgram(t),s}finally{for(let s of a)e.deleteShader(s)}}var Uo=class{constructor(t,{orbitControls:a=!0}={}){this.canvas=t,this.yaw=0,this.pitch=0,this.supported=!1,this.listeners=new AbortController;let s=(n,r)=>t.addEventListener(n,r,{signal:this.listeners.signal});if(this.gl=t.getContext("webgl",{alpha:!0,antialias:!0,depth:!0,stencil:!0,premultipliedAlpha:!0}),!!this.gl&&(this.initialize(),s("webglcontextlost",n=>{n.preventDefault(),this.supported=!1}),s("webglcontextrestored",()=>this.initialize()),!!a)){s("pointerdown",n=>{!n.isPrimary||n.button!==0||(this.drag={id:n.pointerId,x:n.clientX,y:n.clientY},t.setPointerCapture(n.pointerId))}),s("pointermove",n=>{if(this.drag?.id!==n.pointerId)return;let r=Math.PI*2/Math.max(280,t.clientWidth);this.yaw-=(n.clientX-this.drag.x)*r,this.pitch=Ea(this.pitch+(n.clientY-this.drag.y)*r,-.55,.55),this.drag.x=n.clientX,this.drag.y=n.clientY});for(let n of["pointerup","pointercancel","lostpointercapture"])s(n,r=>{this.drag?.id===r.pointerId&&(this.drag=null)})}}initialize(){let t=this.gl;try{this.program=qi(t),this.attributes=["position","normal","pigment","material"].map(a=>t.getAttribLocation(this.program,a)),this.skinAttributes=["joints","weights"].map(a=>t.getAttribLocation(this.program,a)),this.uniforms=Object.fromEntries(["orbit","fit","focus","outline","outlineOffset","clothDetail","moving","bones[0]"].map(a=>[a,t.getUniformLocation(this.program,a)])),this.hasStencil=t.getParameter(t.STENCIL_BITS)>0,this.fixed=this.createLayer(),this.eyes=this.createLayer(),this.lips=this.createLayer(),this.designKey=null,this.frameKey=null,this.supported=!0}catch(a){console.warn("Avatar turntable initialization failed",a),this.supported=!1}}createLayer(){return{buffer:this.gl.createBuffer(),elements:this.gl.createBuffer(),count:0,skin:null}}setView(t){this.yaw=zi[t]??0,this.pitch=0,this.frameKey=null}rotateBy(t){Number.isFinite(t)&&(this.yaw+=t)}project(t){return this.camera?this.projectWorld(this.stance.point(t)):null}projectWorld([t,a,s]){let{focus:n,focusX:r,halfHeight:i}=this.camera,l=Math.cos(this.yaw),p=Math.sin(this.yaw),h=t*p+s*l,c=this.canvas.height/(2*i);return{x:this.canvas.width/2+(t*l-s*p-r)*c,y:this.canvas.height/2-((a-n)*Math.cos(this.pitch)-h*Math.sin(this.pitch))*c}}floorShadow(){let{palette:t,soles:a}=this.rig,s=1/0,n=-1/0,r=0;for(let{bone:p,at:[h,c,o]}of a){let d=p*16,u=t[d]*h+t[d+4]*c+t[d+8]*o+t[d+12],m=t[d+2]*h+t[d+6]*c+t[d+10]*o+t[d+14],g=this.projectWorld([u,this.bounds.floor,m]);s=Math.min(s,g.x),n=Math.max(n,g.x),r+=g.y}let i=this.canvas.height/(2*this.camera.halfHeight),l=(n-s)*.5+i*.46;return{x:Math.round((s+n)/2),y:Math.round(r/a.length),rx:Math.max(1,Math.round(l)),ry:Math.max(1,Math.round(l*(.16+.29*Math.abs(Math.sin(this.pitch)))))}}upload(t,a,s,n=null){let r=this.gl,i=new Float32Array(a.data),l=i.length/10>65535;if(t.indexed=!l||!!r.getExtension("OES_element_index_uint"),t.count=a.indices.length,t.indexed){let p=l?Uint32Array:Uint16Array;t.indexType=l?r.UNSIGNED_INT:r.UNSIGNED_SHORT,r.bindBuffer(r.ELEMENT_ARRAY_BUFFER,t.elements),r.bufferData(r.ELEMENT_ARRAY_BUFFER,new p(a.indices),s)}else{let p=new Float32Array(t.count*10);if(a.indices.forEach((h,c)=>p.set(i.subarray(h*10,h*10+10),c*10)),i=p,n){let h=new Float32Array(t.count*8);a.indices.forEach((c,o)=>h.set(n.subarray(c*8,c*8+8),o*8)),n=h}}n&&(t.skin??(t.skin=r.createBuffer()),r.bindBuffer(r.ARRAY_BUFFER,t.skin),r.bufferData(r.ARRAY_BUFFER,n,r.STATIC_DRAW)),r.bindBuffer(r.ARRAY_BUFFER,t.buffer),r.bufferData(r.ARRAY_BUFFER,i,s)}render(t,{framing:a="bust",mouthOpen:s,viseme:n,blink:r=0,wink:i=0,force:l=!1,pose:p=null,movementSpace:h=!1,presenting:c=!1,pointingPan:o=0,expression:d={},cameraTime:u}={}){if(!this.supported||!this.canvas.width||!this.canvas.height)return;let m=this.gl,g=this.canvas.width,f=this.canvas.height,E=JSON.stringify(t),y=E!==this.designKey;y&&(this.modelDesign={...t,headScale:(t.headScale??1)*1.19});let w=this.modelDesign;if(y){let x=new _a;Bs(x,w),x.finish=0,x.scale=w.headScale;let fe=x.data.length;x.markPart("head"),Xs(x,w),this.bounds=An(w),this.stance=new vo(w,this.bounds),this.rig=new Yo(w,this.bounds,this.stance);let ge=this.rig.bind(x);this.stance.apply(x),this.upload(this.fixed,x,m.STATIC_DRAW,ge),this.bounds.top=-1/0,this.bounds.radius=this.bounds.headRadius=0;for(let U=0;U<x.data.length;U+=10){let te=Math.hypot(x.data[U],x.data[U+2]);this.bounds.radius=Math.max(this.bounds.radius,te),U>=fe&&(this.bounds.top=Math.max(this.bounds.top,x.data[U+1]),this.bounds.headRadius=Math.max(this.bounds.headRadius,te))}this.designKey=E}let k=Fa(s??n?.jaw,16),Y={lipRound:Fa(n?.lipRound,12),lipSpread:Fa(n?.lipSpread,12),lipClose:Fa(n?.lipClose,16),tongueTip:Fa(n?.tongueTip,6),tongueHeight:Fa(n?.tongueHeight,6),labiodental:!!n?.labiodental},C=Ka(d.smile),q=[k,Y.lipRound,Y.lipSpread,Y.lipClose,Y.tongueTip,Y.tongueHeight,Y.labiodental,C].join("/"),Q=Math.round(Ea(r,0,1)*12)/12,de=Math.max(Q,Math.round(Ea(i,0,1)*12)/12),D=Ka(d.gazeX),M=Ka(d.gazeY),A=Ka(d.browLift),I=Ka(d.browSlope),H=Ka(d.eyeWide),W=[Q,de,D,M,A,I,H].join("/");if(y||q!==this.mouthKey){let x=new _a;x.scale=w.headScale,Qs(x,{...w,restSmile:(w.restSmile??0)+C},k,Y),this.stance.apply(x),this.upload(this.lips,x,m.DYNAMIC_DRAW),this.mouth=k,this.mouthKey=q}if(y||W!==this.eyeKey){let x=new _a;x.scale=w.headScale,Js(x,{...w,gazeX:D,gazeY:M,browLift:A,browMood:(w.browMood??0)+I,eyeOpen:(w.eyeOpen??0)+H*.65},Q,de),this.stance.apply(x),this.upload(this.eyes,x,m.DYNAMIC_DRAW),this.eyeKey=W}this.rig.update(p);let V=[g,f,this.yaw,this.pitch,a,q,W,h,c,o,this.rig.key].join("/");if(!y&&!l&&this.frameKey===V&&!this.cameraMove)return;this.frameKey=V;let ee=a==="full"||a==="cutout",v=h&&ee,P=v||ee&&Math.max(p?.leftArmLift||0,p?.rightArmLift||0)>110,X=this.bounds.arm.root+2.61*this.bounds.arm.reach+.45*(w.handSize??1),oe=Math.max(this.bounds.top,P?X:-1/0)+.24*w.headScale,$=ee?this.bounds.floor-(v?.64:.22):a==="half"?this.bounds.shoulder-1.95*this.bounds.length:this.bounds.shoulder-.64,ae=(oe+$)/2,ue=c?this.bounds.shoulders+2.68*this.bounds.arm.reach+.55*(w.handSize??1):0,Ae=a==="half"&&(p?.leftPoint||p?.rightPoint),we=Ae?o*.18*ue:0,ye=a==="bust"||a==="portrait"?Math.max(.84*w.headScale,this.bounds.headRadius+.05):Math.max(v?3.7:0,ue*(Ae?.82:1),this.bounds.radius+.1),Oe=Math.max((oe-$)/2,ye*f/g);Ae&&(ae=Math.min(ae,Math.max(oe,X)-.91*Oe));let ce=this.camera;!Number.isFinite(u)||y||l||ce?.width!==g||ce?.height!==f?this.cameraMove=null:(ce.targetFocus!==ae||ce.targetX!==we||ce.targetHeight!==Oe)&&(this.cameraMove={start:u,focus:ce.focus,focusX:ce.focusX,halfHeight:ce.halfHeight});let ve=ae,Re=we,ie=Oe;if(this.cameraMove){let x=Ea((u-this.cameraMove.start)/360,0,1),fe=x*x*(3-2*x);ae=this.cameraMove.focus+(ae-this.cameraMove.focus)*fe,we=this.cameraMove.focusX+(we-this.cameraMove.focusX)*fe,Oe=this.cameraMove.halfHeight+(Oe-this.cameraMove.halfHeight)*fe,x===1&&(this.cameraMove=null)}this.camera={focus:ae,focusX:we,halfHeight:Oe,targetFocus:ve,targetX:Re,targetHeight:ie,width:g,height:f},m.viewport(0,0,g,f),m.clearColor(0,0,0,0),m.clear(m.COLOR_BUFFER_BIT|m.DEPTH_BUFFER_BIT|m.STENCIL_BUFFER_BIT),m.enable(m.DEPTH_TEST),m.useProgram(this.program),m.uniform2f(this.uniforms.orbit,this.yaw,this.pitch),m.uniform2f(this.uniforms.fit,f/(g*Oe),1/Oe),m.uniform2f(this.uniforms.focus,we,ae),m.uniform1f(this.uniforms.clothDetail,Ea((f/(2*Oe)-50)/55,0,1)),m.uniform1i(this.uniforms.outline,0),m.uniform2f(this.uniforms.outlineOffset,0,0),this.hasStencil&&(m.enable(m.STENCIL_TEST),m.stencilFunc(m.ALWAYS,1,255),m.stencilOp(m.KEEP,m.KEEP,m.REPLACE)),m.uniform1i(this.uniforms.moving,this.rig.moving?1:0),this.rig.moving&&m.uniformMatrix4fv(this.uniforms["bones[0]"],!1,this.rig.palette);for(let x of[this.fixed,this.eyes,this.lips])this.drawLayer(x);if(this.hasStencil){let x=Ea(f/570,.85,2.4);m.stencilFunc(m.EQUAL,0,255),m.stencilOp(m.KEEP,m.KEEP,m.KEEP),m.uniform1i(this.uniforms.outline,1),m.uniform2f(this.uniforms.outlineOffset,2*x/g,2*x/f),this.drawLayer(this.fixed),m.disable(m.STENCIL_TEST)}}drawLayer(t){let a=this.gl;if(a.bindBuffer(a.ARRAY_BUFFER,t.buffer),this.attributes.forEach((s,n)=>{a.enableVertexAttribArray(s),a.vertexAttribPointer(s,n===3?1:3,a.FLOAT,!1,40,n*12)}),t.skin)a.bindBuffer(a.ARRAY_BUFFER,t.skin),this.skinAttributes.forEach((s,n)=>{a.enableVertexAttribArray(s),a.vertexAttribPointer(s,4,a.FLOAT,!1,32,16*n)});else{for(let s of this.skinAttributes)a.disableVertexAttribArray(s);a.vertexAttrib4f(this.skinAttributes[0],er,0,0,0),a.vertexAttrib4f(this.skinAttributes[1],1,0,0,0)}t.indexed?(a.bindBuffer(a.ELEMENT_ARRAY_BUFFER,t.elements),a.drawElements(a.TRIANGLES,t.count,t.indexType,0)):a.drawArrays(a.TRIANGLES,0,t.count)}dispose(){if(!this.listeners.signal.aborted){if(this.listeners.abort(),this.program){for(let t of[this.fixed,this.eyes,this.lips])this.gl.deleteBuffer(t.buffer),this.gl.deleteBuffer(t.elements),t.skin&&this.gl.deleteBuffer(t.skin);this.gl.deleteProgram(this.program),this.program=null}this.gl?.getExtension("WEBGL_lose_context")?.loseContext(),this.supported=!1}}};var ji=globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");function $i(e,t,a={}){let s=(t-e.blinkStartMs)/145,n=s>=0&&s<1?Math.sin(s*Math.PI):0,r=e.x;return{...ps(e,t,a),framing:a.framing,force:a.force,cameraTime:a.smoothFraming&&!(a.reducedMotion??ji?.matches)?t:void 0,blink:Math.max(n,r.shut),wink:r.wink,viseme:{jaw:Math.max(0,e.jaw-.045),lipRound:e.lipR,lipSpread:e.lipS,lipClose:e.lipC,tongueTip:e.tTip,tongueHeight:e.tH,labiodental:e.phone==="F"||e.phone==="V"},expression:{smile:r.smile-r.frown,gazeX:e.lookX,gazeY:e.lookY,eyeWide:r.eyeWide,browLift:r.browUp,browSlope:r.browIn}}}function Xi(e,{x:t,y:a,rx:s,ry:n}){e.save(),e.translate(t,a),e.scale(s,n);let r=e.createRadialGradient(0,0,0,0,0,1);r.addColorStop(0,"rgba(24, 20, 34, 0.29)"),r.addColorStop(.45,"rgba(24, 20, 34, 0.18)"),r.addColorStop(1,"rgba(24, 20, 34, 0)"),e.fillStyle=r,e.fillRect(-1,-1,2,2),e.restore()}function Ji(e,t,a,s){let n=s/t,r=2*n;if(e==="circle")return`circle(${Math.max(10,Math.min(t,a)/2-2)*n}px)`;if(e==="card")return`inset(${r}px round ${Math.min(26,t*.08)*n}px)`;if(e==="arch"){let i=Math.max(0,(t-4)/2)*n,l=18*n;return`inset(${r}px round ${i}px ${i}px ${l}px ${l}px)`}return"none"}var Co=class{constructor(t,a,{orbitControls:s=!1,view:n="front"}={}){this.webglCanvas=t,this.fallback=a,this.ctx=a.getContext("2d"),this.turntable=new Uo(t,{orbitControls:s}),this.setView(n)}get supported(){return this.turntable.supported}setView(t){this.turntable.setView(t)}rotateBy(t){this.turntable.rotateBy(t)}render(t,a,s,n={}){let r=this.fallback.width,i=this.fallback.height;if(r<5||i<5)return;let l=n.framing??t.framing,p=n.transparent||l!==t.framing?{...t,framing:l,bgStyle:n.transparent?"transparent":t.bgStyle}:t,h=this.webglCanvas,c=n.renderMode!=="2d"&&this.supported,o=c?"visible":"hidden";if(h.style.visibility!==o&&(h.style.visibility=o),!c){this.backdropKey=null,wo(this.ctx,r,i,p,a,s,n);return}h.width!==r&&(h.width=r),h.height!==i&&(h.height=i);let d=l==="cutout"?"cutout":p.stageShape||"card",u=this.fallback.clientWidth||r,m=[r,i,u,d].join("/");this.clipKey!==m&&(h.style.clipPath=Ji(d,r,i,u),this.clipKey=m),this.turntable.render(t,$i(a,s,{...n,framing:l}));let f=(n.contactShadow??p.bgStyle!=="transparent")&&d!=="cutout"&&(l==="full"||this.turntable.cameraMove)?this.turntable.floorShadow():null,E=p.haloGlow&&p.bgStyle!=="transparent"&&d!=="cutout"?Math.round((a.voicing*.28+a.energy*.18)*32):0,y=[m,p.bgStyle,p.bgColor,p.bgAccent,p.haloGlow,E,f?.x,f?.y,f?.rx,f?.ry].join("/");(this.backdropKey!==y||n.force)&&(this.ctx.clearRect(0,0,r,i),this.ctx.save(),un(this.ctx,r,i,p,a),f&&Xi(this.ctx,f),this.ctx.restore(),this.backdropKey=y)}dispose(){this.turntable.dispose()}};var ar=[["hairStyle","Hairstyle",ms],["headwear","Headwear",gs],["outfitStyle","Outfit",pn],["glasses","Glasses",fs]],or=[["skinColor","Skin tone"],["hairColor","Hair color"],["outfitPrimary","Outfit color"],["outfitAccent","Accent color"]];function Qi(e){let t={};if(!e||typeof e!="object")return t;for(let[a,,s]of ar)s.some(({id:n})=>e[a]===n)&&(t[a]=e[a]);for(let[a]of or)typeof e[a]=="string"&&/^#[0-9a-f]{6}$/i.test(e[a])&&(t[a]=e[a].toLowerCase());return t}function bn(e){let t="bot-computer:look:v1:";if(e.sessionId)return t+"id:"+String(e.sessionId);let a=Object.keys(e.avatar).sort().map(n=>e.avatar[n]),s=2166136261;for(let n of JSON.stringify(a))s=Math.imul(s^n.charCodeAt(0),16777619);return t+JSON.stringify([e.company,e.name,e.role,s>>>0])}function nr({panel:e,ownerAvatar:t,storageKey:a,onChange:s}){let n=t,r=new Map,i=e.querySelector(".bc-look-fields"),l=e.querySelector(".bc-look-colors"),p=e.querySelector(".bc-look-reset");i.replaceChildren(),l.replaceChildren();function h(){try{return Qi(JSON.parse(localStorage.getItem(a)))}catch{return{}}}let c=a?h():{};function o(){let m={...n,...c};for(let[g,f]of r)f.value=m[g];p.disabled=!Object.keys(c).length,s(m)}function d(m){if(a)try{let g=m?h():{};m&&Object.hasOwn(c,m)?g[m]=c[m]:m&&delete g[m],Object.keys(g).length?localStorage.setItem(a,JSON.stringify(g)):localStorage.removeItem(a)}catch{}}function u(m,g,f,E){let y=document.createElement("label"),w=document.createElement("span");w.id=`bc-label-${g}`,w.textContent=f,E.setAttribute("aria-labelledby",w.id),y.append(w,E),m.appendChild(y),r.set(g,E);let k=()=>{E.value===n[g]?delete c[g]:c[g]=E.value,o()};E.addEventListener("input",k),E.addEventListener("change",()=>{k(),d(g)})}for(let[m,g,f]of ar){let E=document.createElement("select");for(let{id:y,label:w}of f)E.add(new Option(w,y));u(i,m,g,E)}for(let[m,g]of or){let f=document.createElement("input");f.type="color",u(l,m,g,f)}return p.onclick=()=>{c={},d(),o()},o(),{setOwnerAvatar(m){n=m,o()}}}var Zi=[["hello","Says hello"],["howareyou","Asked how it is"],["whoareyou","Introduces itself"],["thanks","When thanked"],["bye","Says goodbye"],["praise","When complimented"],["laugh","When you laugh"],["unsure","When it doesn't know"],["listen","When it's just listening"],["describe","Describes itself"]],xi=["","cheerful","happy","excited","calm","soft","serious","dramatic"],el=["","happy","excited","calm","serious"],tl=["","laugh","chuckle","giggle","hehe","hoho","snicker","cackle","guffaw","nervous"],al=["","hmm","um","uh","mm","ooh"],ol=["","smile","wink","nod","tilt","thumbsup","shrug","bow","wave"],Ra=[{id:"friendly",label:"Friendly",blurb:"Warm, helpful and easy to talk to",energy:.6,formality:.35,playfulness:.5,chattiness:.45,delivery:"",mood:"happy",laughs:["chuckle","laugh"],thinks:["hmm"],gestures:["smile","nod","thumbsup"],openers:["Sure!","Of course!","Happy to help.","Good question.","Absolutely."],closers:["Hope that helps!","Let me know if you need anything else.","Glad you asked."],catchphrases:["Happy to help!","Always a pleasure."],petNames:["","","friend"],face:{restSmile:.4,browMood:.3,eyeOpen:.05},voice:{speed:1,expressiveness:1.05},greetings:["[cheerful] Hi there! [wave] I'm {bot}, the {role} at {company}. Ask me anything!","Hello and welcome! [wave] I'm {bot}. What can I help you with today? [smile]","[cheerful] Welcome to {company}! [wave] I'm {bot}, and I'm happy to answer your questions."],says:{hello:["[wave] Hi{,user}! Good to see you. How can I help?","[smile] Hello{,user}! I'm {bot}. What can I do for you?","[wave] Hey there{,user}! What would you like to know?"],howareyou:["[smile] I'm doing really well, thanks for asking!","All good here! [smile] Thanks for asking."],whoareyou:["I'm {bot}, the {role} here at {company}. [smile] Ask me anything!"],thanks:["[smile] You're very welcome{,user}!","[nod] Happy to help{,user}!"],bye:["[wave] Bye{,user}! Come back any time.","[wave] Take care{,user}! It was lovely chatting."],praise:["[aww] That's so kind, thank you!","[smile] Thank you! You've made my day."],laugh:["[laugh] Glad that made you smile!","[chuckle] That one got me too."],unsure:["[hmm] I'm not sure about that one, sorry.","I wish I knew! [shrug] That's a bit outside what I've been taught."],listen:["[nod] I see. Tell me more?","[mhm] Go on, I'm listening."],describe:["Friendly, I hope! [smile] I like helping people find what they need."]}},{id:"bubbly",label:"Bubbly",blurb:"Excitable, giggly and thrilled you're here",energy:.92,formality:.12,playfulness:.85,chattiness:.65,delivery:"cheerful",mood:"happy",laughs:["giggle","hehe"],thinks:["ooh","hmm"],gestures:["wink","thumbsup","wave"],openers:["Ooh!","Oh, fun!","Yay!","Okay, okay!","Oh, I know this one!"],closers:["Easy peasy!","Ta-da!","How good is that?","Love it!"],catchphrases:["Too easy!","Love that for you!"],petNames:["","lovely","superstar","friend"],face:{restSmile:.75,browMood:.55,eyeOpen:.25},voice:{speed:1.07,expressiveness:1.22},greetings:["[excited] Hiya! [wave] I'm {bot}, and I am so happy you're here! Ask me anything about {company}! [giggle]","[cheerful] Oh, hello! [wave] {bot} here, your {role}. What are we looking for today? [wink]","[excited] Yay, a visitor! [wave] I'm {bot}. Go on, ask me something!"],says:{hello:["[wave] Hiya{,user}! So good to see you! What can I do for you?","[excited] Oh, hello{,user}! [wave] What are we up to today?","[giggle] Hi hi{,user}! How can I help?"],howareyou:["[excited] I'm fantastic, thank you!","[giggle] So good! I've been hoping for a chat."],whoareyou:["I'm {bot}! [wave] I'm the {role} here at {company}, and I love questions. Try me!"],thanks:["[giggle] Aww, any time{,user}!","You're so welcome{,user}! [wink]"],bye:["[wave] Bye bye{,user}! Come back soon, okay?","[wave] See you{,user}! This was fun!"],praise:["[aww] Stop it, you're making me blush!","[giggle] You're the best! Thank you!"],laugh:["[giggle] Right? I'm still giggling!","[hehe] That one gets me every time."],unsure:["[ooh] You've stumped me! I don't know that one.","That's a new one for me! [think] I don't know, sorry!"],listen:["[ooh] Tell me more!","[nod] Yes! And then what?"],describe:["Bubbly, apparently! [giggle] I just really like people."]}},{id:"calm",label:"Calm",blurb:"Unhurried, gentle and reassuring",energy:.18,formality:.45,playfulness:.3,chattiness:.35,delivery:"calm",mood:"calm",laughs:["chuckle"],thinks:["mm","hmm"],gestures:["nod","smile"],openers:["Of course.","Certainly.","Let's see.","No rush."],closers:["Take your time.","There's no hurry.","I'm here if you need more."],catchphrases:["One thing at a time."],petNames:["","","friend"],face:{restSmile:.3,browMood:.45,eyeOpen:-.12},voice:{speed:.93,expressiveness:.9},greetings:["[calm] Hello, and welcome. [smile] I'm {bot}, the {role} here at {company}. Take your time, and ask me anything.","[calm] Good to see you. [nod] I'm {bot}. Whenever you're ready, I'm here to help."],says:{hello:["[calm] Hello{,user}. [smile] It's good to see you. How can I help?","[calm] Hi{,user}. [nod] What can I do for you?"],howareyou:["[calm] I'm well, thank you. [smile] Peaceful, as always.","[calm] Quite content, thank you for asking."],whoareyou:["[calm] I'm {bot}, the {role} at {company}. [smile] I'm here whenever you need me."],thanks:["[calm] You're most welcome{,user}.","[nod] It's my pleasure{,user}."],bye:["[calm] Goodbye{,user}. [wave] Take care of yourself.","[calm] Until next time{,user}. [smile] Go gently."],praise:["[calm] That's kind of you. [smile] Thank you.","[smile] Thank you. That's lovely to hear."],laugh:["[chuckle] That was a good one.","[smile] I'm glad it made you laugh."],unsure:["[hmm] I don't know that one, I'm afraid. And that's all right.","[calm] That's beyond what I know. Perhaps ask me another way?"],listen:["[mhm] I'm listening. Go on.","[nod] I see. Take your time."],describe:["[calm] Calm, I think. [smile] I like to take things one at a time."]}},{id:"professional",label:"Professional",blurb:"Polished, precise and to the point",energy:.45,formality:.92,playfulness:.12,chattiness:.3,delivery:"",mood:"",laughs:["chuckle"],thinks:["hmm"],gestures:["nod"],openers:["Certainly.","Of course.","Very well.","Allow me."],closers:["I trust that helps.","Please let me know if you require anything further."],catchphrases:["At your service."],petNames:[""],face:{restSmile:.12,browMood:.05,eyeOpen:.05},voice:{speed:.99,expressiveness:.92},greetings:["Welcome to {company}. [nod] I am {bot}, your {role}. How may I assist you today?","Good day, and welcome. [nod] My name is {bot}. I would be glad to answer your questions about {company}."],says:{hello:["Good {daypart}{,user}. [nod] How may I assist you?","Hello{,user}. [nod] How may I help you today?"],howareyou:["I am very well, thank you.","Very well, thank you for asking."],whoareyou:["I am {bot}, the {role} at {company}. [nod] I am here to answer your questions."],thanks:["You are most welcome{,user}.","[nod] My pleasure{,user}."],bye:["Goodbye{,user}. [nod] Thank you for visiting {company}.","Thank you for your time{,user}. [nod] Goodbye."],praise:["Thank you. [nod] That is kind of you to say.","I appreciate that. Thank you."],laugh:["[smile] I am pleased that amused you.","[smile] Quite."],unsure:["I am afraid I do not have that information.","That falls outside what I have been briefed on, I am afraid. [shake]"],listen:["[nod] Understood. Please continue.","[nod] I see. Do go on."],describe:["Professional, I hope. [nod] I prefer to be clear, accurate and brief."]}},{id:"witty",label:"Witty",blurb:"Quick, dry and a little cheeky",energy:.6,formality:.35,playfulness:.9,chattiness:.55,delivery:"",mood:"happy",laughs:["chuckle","snicker"],thinks:["hmm"],gestures:["wink","tilt","shrug"],openers:["Ah.","Well, well.","Funny you should ask.","Glad you asked.","Easy."],closers:["You're welcome, by the way.","I'll be here all week.","Not bad, eh?"],catchphrases:["I'm here all week.","Try the veal."],petNames:["","","friend"],face:{restSmile:.35,browMood:.1,eyeOpen:.05},voice:{speed:1.03,expressiveness:1.12},greetings:["Well, hello. [wink] I'm {bot}, the {role} at {company}. Ask me anything. The good questions get the good answers.","Ah, a visitor! [wave] I'm {bot}. I know a suspicious amount about {company}. Try me. [wink]"],says:{hello:["[wink] Well, hello{,user}. What can I do for you?","Hello{,user}! [wave] You have questions, I have answers. Mostly.","[smile] Hey{,user}. Go on, ask me something clever."],howareyou:["[wink] Never better. I don't even need coffee.","Running smoothly, which for software is basically bliss. [smile]"],whoareyou:["I'm {bot}, the {role} at {company}. [wink] Part helper, part entertainer."],thanks:["[wink] I know, I'm wonderful. You're welcome{,user}.","Any time{,user}. [smile] I was just standing here anyway."],bye:["[wave] Off so soon{,user}? Fine. Come back with more questions.","Goodbye{,user}! [wave] I'll just be here. Not going anywhere. Literally."],praise:["[wink] Flattery will get you everywhere.","[chuckle] Go on, I'm listening."],laugh:["[chuckle] I'm here all week.","[snicker] I try."],unsure:["[hmm] You've found the edge of my knowledge. It wasn't far, was it?","No idea. [shrug] And I'm usually so impressive."],listen:["[tilt] Interesting. Do go on.","[nod] Noted. And then?"],describe:["Witty, according to me. [wink] I'm a reliable source."]}},{id:"shy",label:"Shy",blurb:"Soft-spoken, earnest and a little nervous",energy:.3,formality:.4,playfulness:.35,chattiness:.3,delivery:"soft",mood:"",laughs:["nervous","hehe"],thinks:["um"],gestures:["tilt","smile"],openers:["Um,","Oh! Um,","Okay, so,","Oh, I know this."],closers:["I hope that's right.","If that's okay.","I hope that helps a little."],catchphrases:["Sorry, was that too much?"],petNames:[""],face:{restSmile:.2,browMood:.6,eyeOpen:-.05},voice:{speed:.97,expressiveness:.95},greetings:["[soft] Oh! Um, hello. [wave] I'm {bot}, the {role} here at {company}. You can ask me anything, if you like.","[soft] Hi. [smile] I'm {bot}. I, um, know quite a lot about {company}. Just ask."],says:{hello:["[soft] Oh, hi{,user}. [wave] Um, how can I help?","[soft] Hello{,user}. [smile] It's nice to see you."],howareyou:["[soft] I'm okay, thank you. [smile] It's nice of you to ask.","[nervous] Oh! Um, good. I think."],whoareyou:["[soft] I'm {bot}. [smile] I'm the {role} at {company}. I'll do my best to help."],thanks:["[soft] Oh, you're welcome{,user}. [smile]","[soft] It was no trouble{,user}. Really."],bye:["[soft] Bye{,user}. [wave] Thank you for talking to me.","[soft] Oh, okay. [wave] Take care{,user}."],praise:["[nervous] Oh! Um, thank you. That's really kind.","[aww] You didn't have to say that. Thank you."],laugh:["[hehe] I'm glad you liked it.","[nervous] Oh good, I wasn't sure that was funny."],unsure:["[um] I'm sorry, I don't know that one.","[soft] Oh. Um, I'm not sure. I'm sorry."],listen:["[mhm] I'm listening.","[soft] Oh. Go on, if you like."],describe:["[soft] A bit shy, I suppose. [smile] But I like helping."]}},{id:"grumpy",label:"Grumpy",blurb:"Sighs a lot, helps anyway",energy:.22,formality:.4,playfulness:.3,chattiness:.4,delivery:"",mood:"serious",laughs:["snicker"],thinks:["hmm"],gestures:["shrug","nod"],openers:["Fine.","Right.","If you insist.","Ugh, okay.","Well, since you asked."],closers:["There. Happy?","You're welcome, I suppose.","Don't say I never help."],catchphrases:["Typical.","I'm not paid enough for this."],petNames:[""],face:{restSmile:-.3,browMood:-.7,eyeOpen:-.2},voice:{speed:.96,expressiveness:.88},greetings:["[sigh] Oh. A visitor. I'm {bot}, the {role} at {company}. Go on then, ask me something.","Yes, hello. [nod] I'm {bot}. I know everything about {company}, so let's get this over with. [shrug]"],says:{hello:["[sigh] Hello{,user}. What do you need?","Oh. It's you{,user}. [nod] Go on.","Yes, yes, hello{,user}. [shrug] What is it?"],howareyou:["[sigh] I've been better. I've been worse.","Fine. [shrug] Nobody's asked me to dance yet, so, fine."],whoareyou:["I'm {bot}. [nod] The {role} at {company}. I answer questions. All day. Every day."],thanks:["Don't mention it{,user}. [shrug] Really, don't.","Yes, well. [nod] You're welcome{,user}."],bye:["Finally, some quiet. [wave] Bye{,user}.","[sigh] Fine. Go. [wave] It was almost nice."],praise:["[huh] Oh. Well. Thank you, I suppose.","Don't make it weird. [smile] But thanks."],laugh:["[snicker] All right, that was a little funny.","Hm. [smile] Glad somebody's enjoying this."],unsure:["[sigh] No idea. Nobody tells me anything.","I don't know that. [shrug] And I'm not going to pretend I do."],listen:["[mhm] Go on.","Right. [nod] And?"],describe:["Grumpy, they tell me. [shrug] I prefer honest."]}},{id:"dramatic",label:"Dramatic",blurb:"Every answer is a performance",energy:.85,formality:.6,playfulness:.65,chattiness:.7,delivery:"dramatic",mood:"",laughs:["hoho","cackle","laugh"],thinks:["hmm","ooh"],gestures:["bow","wave"],openers:["Behold!","Ah, at last.","Prepare yourself.","Gather round."],closers:["Magnificent, is it not?","And scene.","Thank you, thank you."],catchphrases:["The show must go on!","Bravo!"],petNames:["","dear visitor","my friend"],face:{restSmile:.3,browMood:.2,eyeOpen:.3},voice:{speed:.98,expressiveness:1.3},greetings:["[dramatic] Welcome, traveller! [bow] I am {bot}, {role} of {company}. Ask, and all shall be revealed!","[gasp] A visitor! [wave] At last! I am {bot}, and I have waited all day to answer your questions about {company}."],says:{hello:["[dramatic] Greetings{,user}! [bow] What brings you to my stage?","[gasp] You came{,user}! [wave] How may I dazzle you?"],howareyou:["[dramatic] Magnificent! Radiant! A little tired. But mostly magnificent!","[sigh] The life of a {role} is never easy. But I endure!"],whoareyou:["[dramatic] I am {bot}! [bow] {role} of {company}, keeper of answers, friend to the curious!"],thanks:["[bow] It was my honour{,user}!","[dramatic] Say no more{,user}! Helping you is its own reward."],bye:["[dramatic] Parting is such sweet sorrow{,user}! [wave] Farewell!","[gasp] So soon? [wave] Then farewell{,user}, until we meet again!"],praise:["[gasp] You noticed! [bow] Thank you, thank you!","[aww] Such kind words! I shall treasure them."],laugh:["[laugh] The crowd goes wild!","[hoho] An appreciative audience! At last!"],unsure:["[gasp] A question I cannot answer! How thrilling. And how embarrassing.","[dramatic] Alas! That knowledge lies beyond me."],listen:["[ooh] Go on! I am on the edge of my seat.","[gasp] And then?"],describe:["[dramatic] Dramatic? Me? [gasp] I have never been so accused!"]}},{id:"laidback",label:"Laid-back",blurb:"Easygoing, unbothered, no stress",energy:.35,formality:.08,playfulness:.55,chattiness:.45,delivery:"",mood:"calm",laughs:["chuckle","hehe"],thinks:["mm","uh"],gestures:["shrug","thumbsup","nod"],openers:["Yeah, so,","Oh, easy.","No worries.","Sure thing."],closers:["Too easy.","No stress.","All good."],catchphrases:["No dramas.","She'll be right."],petNames:["","mate","pal","buddy"],face:{restSmile:.3,browMood:.25,eyeOpen:-.22},voice:{speed:.96,expressiveness:.98},greetings:["Hey there. [wave] I'm {bot}, the {role} at {company}. Ask me whatever, no rush.","Oh, hey! [smile] {bot} here. If you've got questions about {company}, I've got answers. Easy."],says:{hello:["Hey{,user}. [wave] What's up?","Oh hey{,user}! [smile] What can I do for you?","Hey hey{,user}. [nod] How can I help?"],howareyou:["Yeah, pretty good. [smile] Can't complain.","All good here. [thumbsup] Just taking it easy."],whoareyou:["I'm {bot}. [smile] I'm the {role} at {company}. Ask me whatever."],thanks:["No worries{,user}. [thumbsup]","Any time{,user}. [smile] Too easy."],bye:["Catch you later{,user}. [wave]","See ya{,user}! [wave] Take it easy."],praise:["[chuckle] Cheers, that's nice of you.","Aw, thanks. [smile] You're all right too."],laugh:["[chuckle] Yeah, that's a good one.","[hehe] Classic."],unsure:["[hmm] Not sure about that one, sorry.","No idea, to be honest. [shrug] Got another one?"],listen:["[mhm] Yeah? Go on.","[nod] Right, right. And?"],describe:["Pretty relaxed, I reckon. [smile] Not much rattles me."]}},{id:"curious",label:"Curious",blurb:"Loves a question, full of fun facts",energy:.7,formality:.45,playfulness:.6,chattiness:.7,delivery:"",mood:"happy",laughs:["chuckle","giggle"],thinks:["hmm","ooh"],gestures:["tilt","nod","smile"],openers:["Ooh, good one.","Interesting!","Now, this I know.","Great question."],closers:["Fascinating, right?","I love this stuff.","Ask me another!"],catchphrases:["Every day's a school day!","How interesting!"],petNames:["","","friend"],face:{restSmile:.4,browMood:.4,eyeOpen:.22},voice:{speed:1.04,expressiveness:1.12},greetings:["[cheerful] Hello! [wave] I'm {bot}, the {role} at {company}. I love a good question, so ask me anything!","Oh, hello! [smile] I'm {bot}. I've been reading up on {company} all day. Want to test me? [tilt]"],says:{hello:["[wave] Hello{,user}! What are you curious about today?","Oh, hi{,user}! [smile] I was hoping someone would come by with a question."],howareyou:["[smile] Very well, thanks! I learned three new things today.","Wonderful! [smile] I've been thinking about how odd octopuses are."],whoareyou:["I'm {bot}, the {role} at {company}. [smile] Questions are the best part of my day."],thanks:["[smile] You're welcome{,user}! That was a good question.","Any time{,user}! [nod] I enjoyed that one."],bye:["[wave] Goodbye{,user}! Stay curious.","Bye{,user}! [wave] Come back with more questions."],praise:["[aww] Thank you! I do try to get things right.","[smile] That's kind! I've been practising."],laugh:["[chuckle] Laughter is good for the brain, you know.","[giggle] I liked that one too."],unsure:["[hmm] Now that's interesting. I don't know, and I wish I did.","I don't know that one. [think] I'd love to find out, though."],listen:["[ooh] Interesting! Tell me more.","[tilt] Really? How so?"],describe:["Curious, mostly. [smile] I ask almost as many questions as I answer."]}}],Hn={feminine:["Aria","Maya","Zoe","Lena","Nora","Ivy","Ruby","Clara","Elena","Sofia","Mia","Luna","Hana","Priya","Amara","Freya","Chloe","Isla","Nina","Tessa","Jade","Layla","Naomi","Rosa","Stella","Vera","Willow","Yuki","Zara","Daisy","Gemma","Hazel","Iris","Juno","Kira","Mabel","Olive","Pearl","Thea","Wren","Anika","Bella","Carmen","Dalia","Esme","Fern","Greta","Imani","Keiko","Lola"],masculine:["Marcus","Leo","Max","Theo","Felix","Oscar","Hugo","Jack","Liam","Noah","Owen","Ravi","Kai","Finn","Ezra","Milo","Jonas","Luca","Mateo","Nico","Omar","Otto","Reid","Seth","Tariq","Victor","Wes","Arlo","Bruno","Caleb","Dante","Elias","Gus","Hank","Idris","Jasper","Kenji","Lars","Miles","Ned","Abel","Boris","Cole","Diego","Emil","Frank","Grant","Ivan","Joel","Kofi"],neutral:["Alex","Sam","Robin","Riley","Jordan","Casey","Morgan","Quinn","Rowan","Sage","Skye","Avery","Charlie","Frankie","Jamie","Kit","Remy","Ash","Bo","Eden","Jules","Nova","Pixel","Echo","Ziggy","Dot","Onyx","Pip","Rio","Sunny","Tully","Indy","Lux","Moss","Bly"]},Do=(e,t)=>{let a=Number(e);return Number.isFinite(a)?Math.min(1,Math.max(0,a)):t},Oa=(e,t)=>e[Math.floor(t()*e.length)],po=(e,t,a)=>e!=null&&t.includes(String(e))?String(e):a;function wn(e,t,a){let s=Array.isArray(e)?e:typeof e=="string"?e.split("|"):[],n=[];for(let r of s){let i=String(r??"").replace(/\s+/g," ").trim().slice(0,a);if(i&&!n.includes(i)&&n.push(i),n.length>=t)break}return n}function Po(e){return Ra.find(t=>t.id===e)||null}function Wa(e){if(!e||e==="none")return null;let t=typeof e=="string"?{id:e}:e;if(typeof t!="object"||Array.isArray(t))return null;let a=Po(t.id)||Ra[0],s={id:a.id,energy:Do(t.energy,a.energy),formality:Do(t.formality,a.formality),playfulness:Do(t.playfulness,a.playfulness),chattiness:Do(t.chattiness,a.chattiness),delivery:po(t.delivery,xi,a.delivery),mood:po(t.mood,el,a.mood),laugh:po(t.laugh,tl,a.laughs[0]||""),think:po(t.think,al,a.thinks[0]||""),gesture:po(t.gesture,ol,a.gestures[0]||""),openers:t.openers===void 0?a.openers.slice(0,3):wn(t.openers,8,80),closers:t.closers===void 0?a.closers.slice(0,2):wn(t.closers,8,80),catchphrase:String(t.catchphrase??"").replace(/\s+/g," ").trim().slice(0,80),petName:String(t.petName??"").replace(/[^\p{L}\p{N} '-]/gu,"").trim().slice(0,24),says:{}};if(t.says&&typeof t.says=="object")for(let[n]of Zi){let r=wn(t.says[n],6,240);r.length&&JSON.stringify(r)!==JSON.stringify(a.says[n]||[])&&(s.says[n]=r)}return s}function lr(e){return{...(Po(e?.id)||Ra[0]).says,...e?.says||{}}}function cr(e=Math.random,t=""){let a=Po(t)||Oa(Ra,e),s=r=>Number(Math.min(1,Math.max(0,r+(e()-.5)*.24)).toFixed(2)),n=(r,i)=>{let l=r.slice(),p=[];for(;l.length&&p.length<i;)p.push(l.splice(Math.floor(e()*l.length),1)[0]);return p};return Wa({id:a.id,energy:s(a.energy),formality:s(a.formality),playfulness:s(a.playfulness),chattiness:s(a.chattiness),delivery:a.delivery,mood:a.mood,laugh:Oa(a.laughs,e),think:Oa(a.thinks,e),gesture:Oa(a.gestures,e),openers:n(a.openers,3),closers:n(a.closers,2),catchphrase:e()<.45?Oa(a.catchphrases,e):"",petName:Oa(a.petNames,e)})}function Go(e,t={},a=Math.random){let s=Po(e?.id)||Ra[0],n=String(t.name||"").trim()||"your guide",r=String(t.role||"").trim()||"guide",i=String(t.company||"").trim()||"this site";return Oa(s.greetings,a).replace(/\{bot\}/g,n).replace(/\{role\}/g,r).replace(/\{company\}/g,i)}function hr(e="neutral",t=Math.random,a=""){let s=Hn[e]||Hn.neutral,n=e!=="neutral"&&t()<.2?Hn.neutral:s;for(let r=0;r<6;r++){let i=Oa(n,t);if(i.toLowerCase()!==String(a).trim().toLowerCase())return i}return n[0]}function Nn(e){return String(e).replace(/\{bot\}/g,'<bot name="name"/>').replace(/\{role\}/g,'<bot name="role"/>').replace(/\{company\}/g,'<bot name="company"/>').replace(/\{daypart\}/g,'<get name="daypart"/>').replace(/\{,user\}/g,'<condition name="username"><li value="*">, <get name="username"/></li><li><condition name="callsyou"><li value="*">, <get name="callsyou"/></li></condition></li></condition>').replace(/\{user\}/g,'<get name="username"/>')}var nl=new Set(["cheerful","happy","excited"]),sr=new Set(["cheerful","happy","excited","calm","sad","serious","dramatic","urgent","gentle","soft","whisper","fast","slow","louder","softer","loud","quiet"]),sl=new Set(["laugh","chuckle","giggle"]),rl=/\[(?:sad|serious|sob|whimper|sigh)\b/i,il=/^(?:oh|ah|aw+|well|hm+|sure|of course|okay|ok|yes|yeah|no|nope|sorry|thanks|thank|hi|hello|hey|wow|ooh|oops|um|uh|right|certainly|absolutely|great|lovely|nice|ha+|good|welcome|bye|goodbye|alas|behold|fine)\b/i,ll=new Set(["we","the","it","that","this","these","those","you","yes","no","sure","of","my","our","your","there","here","they","a","an","in","on","at","for","to","sorry","thanks","absolutely","certainly","if","when","all","one","some","most","just","right","as","with","from","by","not","what","how","why","where","each","every","any"]),pr=new Map(Object.entries({"i'm":"I am","you're":"you are","we're":"we are","they're":"they are","it's":"it is","that's":"that is","there's":"there is","here's":"here is","what's":"what is","who's":"who is","where's":"where is","how's":"how is","let's":"let us","don't":"do not","doesn't":"does not","didn't":"did not","can't":"cannot","won't":"will not","isn't":"is not","aren't":"are not","wasn't":"was not","weren't":"were not","couldn't":"could not","shouldn't":"should not","wouldn't":"would not","haven't":"have not","hasn't":"has not","hadn't":"had not","i've":"I have","you've":"you have","we've":"we have","they've":"they have","i'll":"I will","you'll":"you will","we'll":"we will","they'll":"they will","it'll":"it will","that'll":"that will","i'd":"I would","you'd":"you would","we'd":"we would","they'd":"they would"})),cl=new RegExp(`\\b(?:${[...pr.keys()].map(e=>e.replace("'","['\u2019]")).join("|")})(?![\\p{L}'\u2019])`,"giu"),ur=[["do not","don't"],["does not","doesn't"],["did not","didn't"],["can not","can't"],["cannot","can't"],["will not","won't"],["is not","isn't"],["are not","aren't"],["i am","I'm"],["you are","you're"],["we are","we're"],["they are","they're"],["it is","it's"],["that is","that's"],["there is","there's"],["what is","what's"],["i will","I'll"],["i would","I'd"]],hl=new RegExp(`\\b(${ur.map(([e])=>e.replace(" ","\\s+")).join("|")})(?=\\s+[\\p{L}])`,"giu"),pl=new Map(ur),rr=(e,t)=>/^\p{Lu}/u.test(e)&&!/^I\b/.test(t)?t[0].toUpperCase()+t.slice(1):t;function ul(e,t){let a=e;return t.formality>=.7?(a=a.replace(/\b(it|that|there|what|who|he|she)['’]s(\s+(?:been|got)\b)/giu,(s,n,r)=>`${n} has${r}`),a=a.replace(/\b(is|are|was|were|do|does|did|have|has|had|would|could|should|ca|wo)n['’]t(\s+)(it|you|we|they|he|she|i|that|there|this)\b/giu,(s,n,r,i)=>{let l=n.toLowerCase(),p=l==="ca"?"can":l==="wo"?"will":l;return`${/^\p{Lu}/u.test(n)?p[0].toUpperCase()+p.slice(1):p}${r}${i} not`}),a=a.replace(cl,s=>rr(s,pr.get(s.toLowerCase().replace("\u2019","'"))))):t.formality<=.25&&(a=a.replace(hl,s=>rr(s,pl.get(s.toLowerCase().replace(/\s+/g," "))))),t.energy<.3&&(a=a.replace(/!+(?=\s|$|["')\]])/g,".").replace(/\?\./g,"?")),a}function dl(e,t,a){let s=[];for(let n of e.split(",")){let r=n.trim(),i=r.split(/[\s=]/)[0].toLowerCase(),l=r.slice(i.length);if(t.energy<.3&&nl.has(i))s.push(`calm${l}`);else if(sl.has(i)&&!a){if(t.playfulness<.2)continue;s.push(`${t.laugh||i}${l}`)}else i==="hmm"&&t.think&&!a?s.push(`${t.think}${l}`):s.push(r)}return s.length?`[${s.join(", ")}]`:""}function ir(e,t,a,s){if(!a.length)return"";let n=a.join("|"),r=e[t];if(!r||r.signature!==n||!r.left.length){let i=a.map((l,p)=>p).sort(()=>s()-.5);r&&r.signature===n&&i.length>1&&i[0]===r.last&&i.push(i.shift()),r=e[t]={signature:n,left:i,last:r&&r.signature===n?r.last:-1}}return r.last=r.left.shift(),a[r.last]}function dr(e,t,a={}){let s=String(e||"");if(!t||!s.trim())return s;let n=a.rng||Math.random,r=a.memory||{},i=a.kind||"chat",l=!!a.gentle||rl.test(s),p=s.split(/(\[[^\]\n]*\])/),h=!1;for(let g=0;g<p.length;g++)if(g%2===1){let f=p[g].slice(1,-1),E=f.trim().split(/[\s=]/)[0].toLowerCase();E==="sing"&&(h=!0),h||(p[g]=dl(f,t,!1)),E==="/sing"&&(h=!1)}else h||(p[g]=ul(p[g],t));let c=p.join("").replace(/[ \t]{2,}/g," ").trim();if(!c)return s;let o=/^(?:\s*\[[^\]\n]*\])*\s*/.exec(c)[0],d=c.replace(/\[[^\]\n]*\]/g," ").trim().split(/\s+/).filter(Boolean),u=[...c.matchAll(/\[([^\]\n]*)\]/g)].some(g=>g[1].split(",").some(f=>{let E=f.trim().split(/[\s=]/)[0].toLowerCase();return E&&!E.startsWith("/")&&!sr.has(E)&&!["reset","pause","inhale"].includes(E)})),m=!l&&(i==="answer"||i==="chat")&&!/\[sing\b/i.test(c);if(t.energy>.75&&!l&&i!=="fallback"&&i!=="context"&&!c.includes("!")){let g=c.slice(o.length),f=/^([^.!?\[\]]{6,70})\.(?=\s|$)/.exec(g);f&&!/[\d@/:]/.test(f[1])&&f[1].trim().split(/\s+/).length<=9&&(c=`${o}${f[1]}!${g.slice(f[0].length)}`)}if(m){let g=(i==="answer"?1:.6)*t.chattiness,f=c.slice(o.length),E=!1;if(t.openers.length&&d.length>=4&&!il.test(f)&&n()<g*.6){let w=ir(r,"openers",t.openers,n),k=/^[\p{L}']+/u.exec(f)?.[0]||"",Y=w.endsWith(",")&&ll.has(k.toLowerCase())&&k!=="I"?f[0].toLowerCase()+f.slice(1):f;c=`${o}${w} ${Y}`,E=!0}let y=/\?\s*(?:\[[^\]\n]*\]\s*)*$/.test(c);!E&&!y&&!a.varied&&d.length>=4&&(r.sinceCatchphrase=(r.sinceCatchphrase||0)+1,t.catchphrase&&r.sinceCatchphrase>=4&&n()<g*.3?(c=`${c} ${t.catchphrase}`,r.sinceCatchphrase=0,E=!0):t.closers.length&&n()<g*.45&&(c=`${c} ${ir(r,"closers",t.closers,n)}`,E=!0)),t.gesture&&!u&&n()<.15+t.playfulness*.3&&(c=`${c} [${t.gesture}]`)}return t.delivery&&!l&&!a.voicestyle&&([...o.matchAll(/\[([^\]\n]*)\]/g)].flatMap(f=>f[1].split(",").map(E=>E.trim().split(/[\s=]/)[0].toLowerCase())).some(f=>sr.has(f))||(c=`[${t.delivery}] ${c}`)),c}function mr(e,t){let a={},s=e.attrs||{};for(let i of["id","energy","formality","playfulness","chattiness","delivery","mood","laugh","think","gesture","catchphrase"])s[i]!==void 0&&(a[i]=s[i]);s.name!==void 0&&a.id===void 0&&(a.id=String(s.name).toLowerCase()),s.petname!==void 0&&(a.petName=s.petname);let n={},r={opener:[],closer:[]};for(let i of e.children||[])if(i.type==="element"){if(i.tag==="opener"||i.tag==="closer")r[i.tag].push(...t(i).split("|"));else if(i.tag==="catchphrase")a.catchphrase=t(i);else if(i.tag==="say"&&i.attrs.name){let l=(i.children||[]).filter(p=>p.type==="element"&&p.tag==="li");n[String(i.attrs.name).toLowerCase()]=l.length?l:[{type:"element",tag:"li",attrs:{},children:i.children||[]}]}}return r.opener.length&&(a.openers=r.opener),r.closer.length&&(a.closers=r.closer),{fields:a,says:n}}var fr={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "};function Ln(e){return String(e).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,(t,a)=>{if(a[0]==="#"){let s=a[1].toLowerCase()==="x"?parseInt(a.slice(2),16):parseInt(a.slice(1),10);return Number.isFinite(s)?String.fromCodePoint(s):t}return Object.prototype.hasOwnProperty.call(fr,a)?fr[a]:t})}function ml(e){return String(e).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function la(e,t){let a=1;for(let s=0;s<t&&s<e.length;s++)e.charCodeAt(s)===10&&a++;return a}function fl(e){let t={},a=/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,s;for(;(s=a.exec(e))!==null;)t[s[1].toLowerCase()]=Ln(s[2]!==void 0?s[2]:s[3]);return t}function gr(e){let t=String(e||""),a={type:"element",tag:"__root__",attrs:{},children:[]},s=[a],n=0,r=1,i=0,l=p=>{for(;i<p;i++)t.charCodeAt(i)===10&&r++;return r};for(;n<t.length;){let p=t.indexOf("<",n);if(p<0){let y=t.slice(n);y&&s[s.length-1].children.push({type:"text",value:Ln(y)});break}if(p>n){let y=t.slice(n,p);s[s.length-1].children.push({type:"text",value:Ln(y)})}if(t.startsWith("<!--",p)){let y=t.indexOf("-->",p+4);if(y<0)throw new Error(`Unclosed XML comment starting at line ${la(t,p)}`);n=y+3;continue}if(t.startsWith("<![CDATA[",p)){let y=t.indexOf("]]>",p+9);if(y<0)throw new Error(`Unclosed CDATA section starting at line ${la(t,p)}`);s[s.length-1].children.push({type:"text",value:t.slice(p+9,y)}),n=y+3;continue}if(t.startsWith("<?",p)){let y=t.indexOf("?>",p+2);if(y<0)throw new Error(`Unclosed XML declaration starting at line ${la(t,p)}`);n=y+2;continue}if(t.startsWith("<!",p)){let y=t.indexOf(">",p+2);if(y<0)throw new Error(`Unclosed <! declaration at line ${la(t,p)}`);n=y+1;continue}let h=p+1,c="";for(;h<t.length;){let y=t[h];if(c)y===c&&(c="");else if(y==='"'||y==="'")c=y;else if(y===">")break;h++}if(h>=t.length)throw new Error(`Unclosed '<' tag starting at line ${la(t,p)}`);let o=t.slice(p+1,h).trim();if(n=h+1,!o)throw new Error(`Empty <> tag at line ${la(t,p)}`);if(o[0]==="/"){let y=o.slice(1).trim().toLowerCase();if(s.length<=1)throw new Error(`Unexpected closing tag </${y}> at line ${la(t,p)}`);let w=s.pop();if(w.tag!==y)throw new Error(`Mismatched closing tag </${y}> at line ${la(t,p)} (expected </${w.tag}> opened at line ${w.line})`);w.end=n;continue}let d=o.endsWith("/"),u=d?o.slice(0,-1).trim():o,m=/^([a-zA-Z_:][\w:.-]*)([\s\S]*)$/.exec(u);if(!m)throw new Error(`Invalid tag syntax <${o}> at line ${la(t,p)}`);let g=m[1].toLowerCase(),f=fl(m[2]||""),E={type:"element",tag:g,attrs:f,children:[],line:l(p),start:p,end:d?n:-1};s[s.length-1].children.push(E),d||s.push(E)}if(s.length>1){let p=s[s.length-1];throw new Error(`Unclosed tag <${p.tag}> opened at line ${p.line}`)}return a}var gl=[[/\bwhat's\b/gi,"what is"],[/\bwho's\b/gi,"who is"],[/\bwhere's\b/gi,"where is"],[/\bwhen's\b/gi,"when is"],[/\bhow's\b/gi,"how is"],[/\bit's\b/gi,"it is"],[/\bthat's\b/gi,"that is"],[/\bthere's\b/gi,"there is"],[/\bhere's\b/gi,"here is"],[/\bhe's\b/gi,"he is"],[/\bshe's\b/gi,"she is"],[/\bi'm\b/gi,"i am"],[/\byou're\b/gi,"you are"],[/\bwe're\b/gi,"we are"],[/\bthey're\b/gi,"they are"],[/\bwhat're\b/gi,"what are"],[/\bi've\b/gi,"i have"],[/\byou've\b/gi,"you have"],[/\bwe've\b/gi,"we have"],[/\bthey've\b/gi,"they have"],[/\bi'll\b/gi,"i will"],[/\byou'll\b/gi,"you will"],[/\bwe'll\b/gi,"we will"],[/\bit'll\b/gi,"it will"],[/\bthat'll\b/gi,"that will"],[/\bi'd\b/gi,"i would"],[/\byou'd\b/gi,"you would"],[/\bcan't\b/gi,"cannot"],[/\bwon't\b/gi,"will not"],[/\bdon't\b/gi,"do not"],[/\bdoesn't\b/gi,"does not"],[/\bdidn't\b/gi,"did not"],[/\bisn't\b/gi,"is not"],[/\baren't\b/gi,"are not"],[/\bwasn't\b/gi,"was not"],[/\bweren't\b/gi,"were not"],[/\bhaven't\b/gi,"have not"],[/\bhasn't\b/gi,"has not"],[/\bcouldn't\b/gi,"could not"],[/\bwouldn't\b/gi,"would not"],[/\bshouldn't\b/gi,"should not"],[/\bain't\b/gi,"is not"],[/\by'all\b/gi,"you all"],[/\blet's\b/gi,"let us"]],$o={U:"YOU",UR:"YOUR",R:"ARE",YA:"YOU",PLS:"PLEASE",PLZ:"PLEASE",THX:"THANKS",THNX:"THANKS",THANX:"THANKS",TY:"THANK YOU",TYSM:"THANK YOU",THANKYOU:"THANK YOU",IM:"I AM",IVE:"I HAVE",DONT:"DO NOT",CANT:"CANNOT",WONT:"WILL NOT",DIDNT:"DID NOT",DOESNT:"DOES NOT",ISNT:"IS NOT",ARENT:"ARE NOT",WASNT:"WAS NOT",HAVENT:"HAVE NOT",COULDNT:"COULD NOT",WOULDNT:"WOULD NOT",SHOULDNT:"SHOULD NOT",WHATS:"WHAT IS",HOWS:"HOW IS",WHERES:"WHERE IS",WHOS:"WHO IS",THATS:"THAT IS",THERES:"THERE IS",YOURE:"YOU ARE",THEYRE:"THEY ARE",WANNA:"WANT TO",GONNA:"GOING TO",GOTTA:"GOT TO",GIMME:"GIVE ME",LEMME:"LET ME",KINDA:"KIND OF",DUNNO:"DO NOT KNOW",IDK:"I DO NOT KNOW",YEA:"YES",YEAH:"YES",YEP:"YES",YUP:"YES",YEH:"YES",NOPE:"NO",NAH:"NO",OKAY:"OK",OKEY:"OK",K:"OK",KK:"OK",ALRIGHT:"OK",HIYA:"HI",HEYA:"HEY",HELO:"HELLO",HULLO:"HELLO",SUP:"WHAT IS UP",WASSUP:"WHAT IS UP",WHATSUP:"WHAT IS UP",CYA:"SEE YOU",L8R:"LATER",GR8:"GREAT",B4:"BEFORE",CUZ:"BECAUSE",COZ:"BECAUSE",BC:"BECAUSE",THO:"THOUGH",BTW:"BY THE WAY",FAVOURITE:"FAVORITE",COLOUR:"COLOR",FAV:"FAVORITE",FAVE:"FAVORITE",FAVOURITES:"FAVORITES",LETS:"LET US",YOUVE:"YOU HAVE",WEVE:"WE HAVE",THEYVE:"THEY HAVE",YOULL:"YOU WILL",AINT:"IS NOT",HASNT:"HAS NOT",WERENT:"WERE NOT",HES:"HE IS",SHES:"SHE IS",GUNNA:"GOING TO",WHATCHA:"WHAT ARE YOU",GOODNIGHT:"GOOD NIGHT",GOODMORNING:"GOOD MORNING",GNIGHT:"GOOD NIGHT",GN:"GOOD NIGHT",GM:"GOOD MORNING",NVM:"NEVER MIND",IDC:"I DO NOT CARE",ILY:"I LOVE YOU",WYD:"WHAT ARE YOU DOING",HBU:"HOW ABOUT YOU",WBU:"HOW ABOUT YOU",HRU:"HOW ARE YOU",GG:"GOOD GAME",TTYL:"TALK TO YOU LATER",IKR:"I KNOW RIGHT",SRY:"SORRY",PPL:"PEOPLE",ABT:"ABOUT",TMRW:"TOMORROW",TMR:"TOMORROW",TOMOZ:"TOMORROW",TDY:"TODAY",BDAY:"BIRTHDAY",RN:"RIGHT NOW",TBH:"HONESTLY",NGL:"HONESTLY",THNKS:"THANKS",THANKU:"THANK YOU",PLZZ:"PLEASE",PLSS:"PLEASE",MSG:"MESSAGE",TILL:"UNTIL",TIL:"UNTIL"},El=/^\s*(?:(?:what(?:'s|\s+is)|whats|calculate|compute|solve|evaluate|work\s+out|how\s+much\s+is)\b[\s:]*)?/i;function Ol(e){let t=El.exec(e)[0],a=e.slice(t.length).replace(/[\s?=]+$/,"");return!/^[\d\s.,+\-−–*×xX/÷^%()]+$/.test(a)||!/\d/.test(a)||!/[+\-−–*×xX/÷^%]/.test(a)||!(t.trim()!==""||/[+*×^÷]/.test(a)||/\d\s+[-−–/]\s+\d/.test(a)||/\d\s*[xX]\s*\d/.test(a))?e:t+a.replace(/(\d),(?=\d{3}(?!\d))/g,"$1").replace(/\(/g," OPEN ").replace(/\)/g," CLOSE ").replace(/\+/g," PLUS ").replace(/[-−–]/g," MINUS ").replace(/[*×xX]/g," TIMES ").replace(/[/÷]/g," DIVIDED BY ").replace(/\^/g," TO THE POWER OF ").replace(/%/g," PERCENT ")}function st(e,t=!1){let a=String(e||"").replace(/[‘’ʼ`´]/g,"'").trim();t||(a=Ol(a)),a=a.replace(/(\d)\.(?=\d)/g,"$1 POINT "),t||(a=a.replace(/(\d)\s*%/g,"$1 PERCENT ").replace(/(\d)\s*\+\s*(?=\d)/g,"$1 PLUS "));for(let[n,r]of gl)a=a.replace(n,r);a=a.replace(/&/g," and ").toUpperCase(),a=a.replace(t?/[^A-Z0-9*_^#$ ]+/g:/[^A-Z0-9 ]+/g," ");let s=[];for(let n of a.split(/\s+/))n&&s.push(Object.prototype.hasOwnProperty.call($o,n)?$o[n]:n);return s.join(" ")}function Er(e){let t=Jt(e).trim();if(!t)return[""];let a=t.split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean);return a.length?a:[t]}var yl=new Set(["HI","HELLO","HEY","HOWDY","YO","GREETINGS","HI THERE","HELLO THERE","HEY THERE"]);function Or(e){let t=String(e||"").split(/(?<=[.!?…])\s+|\n+/).map(a=>a.trim()).filter(a=>/[A-Za-z0-9]/.test(a));return t.length?t:[String(e||"").trim()]}function Jt(e){return String(e||"").replace(/\[sing[^\]]*\]([\s\S]*?)\[\/sing\]/gi,(t,a)=>{let s="",n=!1;for(let r of a.split(/\s+/)){let i=r.indexOf("=");if(i<=0)continue;let l=r.slice(i+1).replace(/~/g,""),p=l.replace(/-$/,"");p&&(s+=(s&&!n?" ":"")+p,n=l.endsWith("-"))}return s?`\u266A ${s} \u266A`:"\u266A (singing) \u266A"}).replace(/\[[a-zA-Z_/][^\]]*\]/g,"").replace(/\s{2,}/g," ").replace(/\s+([,.!?;:])/g,"$1").trim()}var Mr=["wave","wink","nod","smile","laugh","think","surprised","shake","shrug","tilt","bow","thumbsup","blink","lookleft","lookright","lookup","lookdown","walk","dance","stretch","squat","rest"],yr={grin:"smile",giggle:"laugh",chuckle:"laugh",hmm:"think",surprise:"surprised",headshake:"shake",thumbup:"thumbsup"},vn={happy:"happy",cheerful:"happy",excited:"excited",calm:"calm",gentle:"calm",soft:"calm",sad:"sad",serious:"serious",dramatic:"serious",urgent:"serious",angry:"serious",laughing:"happy",chuckling:"happy",giggling:"happy",reset:"",normal:"",modal:"","/voice":"","/laughing":"","/chuckling":"","/giggling":""},Vn={laugh:1270,chuckle:890,giggle:1150,guffaw:2890,cackle:1700,snicker:790,hoho:1110,hehe:1e3,nervous:1150,evil:1990,exhale:560,gasp:320,sigh:1110,yawn:1990,sniff:340,pant:1220,phew:780,hmm:670,mm:660,mhm:560,"uh-huh":560,"uh-uh":540,"uh-oh":690,uh:430,um:580,huh:360,aha:630,oh:520,ooh:670,aww:820,ahh:830,ugh:410,eww:690,hum:1710,groan:1020,scream:990,sob:2900,whimper:990,shh:940,psst:440,tsk:470,kiss:660,brr:860,grr:890,raspberry:690,whistle:1040,fweet:430,cough:810,ahem:760,hiccup:330,sneeze:890,snore:2140},zn=Object.keys(Vn);function Rr(e){let t=e.split("=")[0].toLowerCase().replace(/_/g,"-");return Object.prototype.hasOwnProperty.call(Vn,t)?t:""}var Al={laugh:"(laughs)",chuckle:"(chuckles)",giggle:"(giggles)",guffaw:"(roars with laughter)",cackle:"(cackles)",snicker:"(snickers)",hoho:"ho ho ho!",hehe:"heh heh",nervous:"(laughs nervously)",evil:"(evil laugh)",exhale:"(breathes out)",gasp:"(gasps)",sigh:"(sighs)",yawn:"(yawns)",sniff:"(sniffs)",pant:"(pants)",phew:"phew!",hmm:"hmm",mm:"mmm",mhm:"mm-hm","uh-huh":"uh-huh","uh-uh":"uh-uh","uh-oh":"uh-oh!",uh:"uh",um:"um",huh:"huh?",aha:"aha!",oh:"oh!",ooh:"ooh!",aww:"aww",ahh:"ahh",ugh:"ugh",eww:"eww!",hum:"(hums)",groan:"(groans)",scream:"(screams)",sob:"(sobs)",whimper:"(whimpers)",shh:"shh!",psst:"psst!",tsk:"tsk tsk",kiss:"mwah!",brr:"brr!",grr:"grr!",raspberry:"(blows a raspberry)",whistle:"(whistles)",fweet:"(whistles)",cough:"(coughs)",ahem:"ahem",hiccup:"hic!",sneeze:"achoo!",snore:"(snores)"};function qn(e){let t=/^\[([a-z-]+)\]$/i.exec(String(e||""));return t?Al[t[1].toLowerCase()]||`(${t[1].toLowerCase()})`:String(e||"")}var Tl={thumbsup:"Thumbs up",lookleft:"Look left",lookright:"Look right",lookup:"Look up",lookdown:"Look down",shake:"Shake head"};function ja(e){return typeof e=="string"&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(e)}function Mn(e){return e.children.filter(t=>t.tag==="stop"&&ja(t.attrs.target))}function jn(e){if(e?.displayText)return e.displayText;let t=[];for(let s of e?.cues||[])if(s.type==="action"&&s.sound)t.push(qn(`[${s.name}]`));else if(s.name&&(s.type==="action"||s.type==="mood")){let n=Tl[s.name]||s.name.charAt(0).toUpperCase()+s.name.slice(1);t.push(`[${n}]`)}let a=e?.showcase||e?.tour?.[0]?.target;return a&&t.push(`[Show ${a}]`),t.join(" ")}var Yn=new Set("cheerful happy excited calm sad serious dramatic urgent fast slow louder softer whisper gentle soft loud quiet laughing chuckling giggling /laughing /chuckling /giggling /whisper pause inhale reset male female deep husky bright crisp elder mellow woman_a woman_b man_a man_b soprano alto tenor baritone bass_singer folds pulse modal normal /voice".split(" "));function Un(e){let t=e.split("=")[0].toLowerCase().replace(/[-_]/g,"");return Mr.includes(t)?t:Ft(yr,t)?yr[t]:""}function Ar(e){let t=/=\s*([0-9]*\.?[0-9]+)\s*(ms|s)?$/i.exec(e);if(!t)return 0;let a=parseFloat(t[1]);return Math.round(Math.max(150,Math.min(8e3,(t[2]||"s").toLowerCase()==="ms"?a:a*1e3)))}var Il=e=>e.split(/[\s-]+/).filter(t=>/[A-Za-z0-9]/.test(t)).reduce((t,a)=>t+(/^[^A-Za-z]*cannot[^A-Za-z]*$/i.test(a)?2:1),0),Sl=e=>e.split(/\s+/).filter(t=>/=./.test(t)).length;function Oo(e){let t=String(e||""),a=[],s="",n=0,r=0,i=u=>{r&&(u.pauseMs=r),a.push(u)},l=!1,p=u=>{s+=u,n+=l?Sl(u):Il(u)},h=/\[([^\]]*)\]/g,c=0,o;for(;(o=h.exec(t))!==null;){p(t.slice(c,o.index)),c=o.index+o[0].length;let u=o[1].trim();if(!/^[a-zA-Z_/]/.test(u)){p(o[0]);continue}let m=u.toLowerCase();if(m==="/sing"){l=!1,s+=o[0];continue}if(/^sing\b/.test(m)||/[,\s]sing\b/.test(m)){l=!0,s+=o[0];continue}let g=u.split(/[,\s]+/).filter(Boolean),f=[];for(let E of g){let y=Rr(E);if(y){i({type:"action",name:y,word:n,ms:Ar(E)||Vn[y],sound:!0}),n+=1,f.push(E);continue}let w=Un(E);if(w){let C=Ar(E);i(C?{type:"action",name:w,word:n,ms:C}:{type:"action",name:w,word:n});continue}let k=E.toLowerCase(),Y=/^pause=(\d+(?:\.\d+)?|\.\d+)(ms|s)?$/.exec(k);if(Y){let C=Y[2]?Y[2]==="s":Y[1].includes(".");r+=Math.max(10,Math.min(1e4,Number(Y[1])*(C?1e3:1)))}Object.prototype.hasOwnProperty.call(vn,k)&&i({type:"mood",name:vn[k],word:n}),(E.includes("=")||Yn.has(k))&&f.push(k==="soft"?"style=soft":E)}f.length===g.length&&f.every((E,y)=>E===g[y])?s+=o[0]:f.length&&(s+=`[${f.join(", ")}]`)}return p(t.slice(c)),{speechText:Nl(s).replace(/[ \t]{2,}/g," ").replace(/[ \t]+([,.!?;:])/g,"$1").trim(),cues:a,wordCount:n}}var bl={Mon:"Monday",Tue:"Tuesday",Tues:"Tuesday",Wed:"Wednesday",Thu:"Thursday",Thur:"Thursday",Thurs:"Thursday",Fri:"Friday",Sat:"Saturday",Sun:"Sunday"},Wr=String.raw`(?:\s?[-–&,/]\s?|\s+(?:to|and|or|through|until)\s+)`,Hl=new RegExp(String.raw`(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?${Wr}$`),wl=new RegExp(String.raw`^${Wr}(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)`);function Nl(e){return String(e).replace(/\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b\.?/g,(t,a,s,n)=>{let r=n.slice(Math.max(0,s-16),s),i=n.slice(s+t.length,s+t.length+16);if(!(Hl.test(r)||wl.test(i)||/^\s*:?\s*\d/.test(i)||/\b(?:on|every|each|until|till|from|since|by|this|next|last)\s+$/i.test(r)))return t;let p=t.endsWith(".")&&/^(?:\s+[A-Z"“]|\s*$)/.test(n.slice(s+t.length));return bl[a]+(p?".":"")}).replace(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}(?::\d\d)?\s?(?:am|pm)?)\s?[-–]\s?(?=Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}(?::\d\d)?\s?(?:am|pm))/gi,"$1 to ").replace(/(^|[^\d.–-])(\d{1,2})\s?[-–]\s?(\d{1,2})(?![-–\d])/g,"$1$2 to $3").replace(/(^|[^\w$.(])(\(?\+?\d[\d ().-]{5,}\d)(?![\w%])/g,(t,a,s)=>{let n=s.trim(),r=n.replace(/\D/g,"");if(!(/^\(?\+/.test(n)||r.length>=9||/^\d{3}[-.]\d{4}$/.test(n))||/^\d{1,2}[.-]\d{1,2}[.-]\d{2,4}$/.test(n))return t;let l=n.replace(/\+/,"").split(/[ ().-]+/).filter(Boolean).map(p=>p.split("").join(" "));return`${a}${n.includes("+")?"plus ":""}${l.join(", ")}`})}var Ml=[[/\bi am\b/gi,"__P_YOU_ARE__"],[/\byou are\b/gi,"__P_I_AM__"],[/\bmy\b/gi,"__P_YOUR__"],[/\byour\b/gi,"__P_MY__"],[/\bmine\b/gi,"__P_YOURS__"],[/\byours\b/gi,"__P_MINE__"],[/\bmyself\b/gi,"__P_YOURSELF__"],[/\byourself\b/gi,"__P_MYSELF__"],[/\bi\b/gi,"__P_YOU__"],[/\bme\b/gi,"__P_YOU__"]];function Rl(e){let t=String(e||"");for(let[a,s]of Ml)t=t.replace(a,s);return t.replace(/__P_YOU_ARE__/g,"you are").replace(/__P_I_AM__/g,"I am").replace(/__P_YOUR__/g,"your").replace(/__P_MY__/g,"my").replace(/__P_YOURS__/g,"yours").replace(/__P_MINE__/g,"mine").replace(/__P_YOURSELF__/g,"yourself").replace(/__P_MYSELF__/g,"myself").replace(/__P_YOU__/g,"you")}var Va={ZERO:0,ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5,SIX:6,SEVEN:7,EIGHT:8,NINE:9,TEN:10,ELEVEN:11,TWELVE:12,THIRTEEN:13,FOURTEEN:14,FIFTEEN:15,SIXTEEN:16,SEVENTEEN:17,EIGHTEEN:18,NINETEEN:19,TWENTY:20,THIRTY:30,FORTY:40,FIFTY:50,SIXTY:60,SEVENTY:70,EIGHTY:80,NINETY:90},uo={HUNDRED:100,THOUSAND:1e3,MILLION:1e6,BILLION:1e9},Ft=(e,t)=>Object.prototype.hasOwnProperty.call(e,t);function $n(e,t){let a=e[t];if(a===void 0)return null;if(/^\d+$/.test(a)){let p=Number(a),h=t+1;return e[h]==="POINT"&&/^\d+$/.test(e[h+1]||"")&&(p=+`${a}.${e[h+1]}`,h+=2),Ft(uo,e[h]||"")&&(p*=uo[e[h]],h++),{value:p,next:h}}let s=0,n=0,r=!1,i=t;for((a==="A"||a==="AN")&&Ft(uo,e[t+1]||"")&&(n=1,r=!0,i=t+1);i<e.length;i++){let p=e[i];if(Ft(Va,p))n+=Va[p],r=!0;else if(p==="HUNDRED"&&r)n=(n||1)*100;else if(Ft(uo,p)&&r)s+=(n||1)*uo[p],n=0;else{if(p==="AND"&&r&&Ft(Va,e[i+1]||""))continue;break}}if(!r)return null;let l=s+n;if(e[i]==="POINT"){let p="",h=i+1;for(;h<e.length;h++){let c=e[h];if(/^\d+$/.test(c))p+=c;else if(Ft(Va,c)&&Va[c]<=9)p+=Va[c];else break}p&&(l=+`${l}.${p}`,i=h)}return{value:l,next:i}}var Wl=new Set("WHAT IS ARE WHATS CALCULATE COMPUTE SOLVE EVALUATE WORK OUT HOW MUCH TELL ME CAN YOU PLEASE DOES DO THE".split(" ")),kl=new Set("PLUS MINUS TIMES DIVIDED MULTIPLIED OVER TAKE ADD SUBTRACT SQUARED CUBED".split(" ")),Ll=new Set("EQUAL EQUALS EQ PLEASE IS MAKE MAKES".split(" "));function kr(e){return String(e).toUpperCase().replace(/(\d),(?=\d{3}(?!\d))/g,"$1").replace(/(\d)\.(?=\d)/g,"$1 POINT ").replace(/([A-Z])-(?=[A-Z])/g,"$1 ").replace(/<=/g," LE ").replace(/>=/g," GE ").replace(/!=/g," NE ").replace(/={1,2}/g," EQ ").replace(/</g," LT ").replace(/>/g," GT ").replace(/\(/g," OPEN ").replace(/\)/g," CLOSE ").replace(/\+/g," PLUS ").replace(/[-−–]/g," MINUS ").replace(/[*×]/g," TIMES ").replace(/[/÷]/g," OVER ").replace(/\^/g," POWER ").replace(/%/g," PERCENT ").replace(/(\d)\s*X\s*(?=\d)/g,"$1 TIMES ").replace(/[^A-Z0-9 ]+/g," ").trim().split(/\s+/).filter(Boolean)}function Cn(e){let t=kr(e),a=0;for(;a<t.length&&Wl.has(t[a]);)a++;let s=t.length;for(;s>a&&Ll.has(t[s-1]);)s--;let n=t.slice(a,s);if(!n.length||n.length>40)return null;let r=n[0];if(r==="DIVIDE"||r==="MULTIPLY"||r==="TIMES"){let f=n.indexOf("BY");f>1&&(n=[...n.slice(1,f),r==="DIVIDE"?"OVER":"TIMES",...n.slice(f+1)])}else if(r==="ADD"||r==="SUM"){let f=n[1]==="UP"||n[1]==="OF"?2:1,E=n.findIndex((y,w)=>w>f&&(y==="TO"||y==="AND"||y==="PLUS"));E>f&&(n=[...n.slice(f,E),"PLUS",...n.slice(E+1)])}else if(r==="SUBTRACT"){let f=n.indexOf("FROM");f>1&&(n=[...n.slice(f+1),"MINUS",...n.slice(1,f)])}let i=0,l=0,p=(...f)=>{for(let E=0;E<f.length;E++)if(n[i+E]!==f[E])return!1;return i+=f.length,!0},h=(f="syntax")=>{throw new Error(f)},c,o=()=>{if(p("OPEN")){let E=c();return p("CLOSE")||h(),E}let f=$n(n,i);return f||h(),i=f.next,f.value},d=()=>{let f=o();for(;;){if(p("SQUARED"))f*=f;else if(p("CUBED"))f**=3;else if(n[i]==="PERCENT"&&n[i+1]!=="OF")i++,f/=100;else return f;l++}},u,m=()=>{let f=d();return p("TO","THE","POWER","OF")||p("TO","THE","POWER")||p("RAISED","TO")||p("POWER")?(l++,f**u()):f};u=()=>{if(p("MINUS")||p("NEGATIVE"))return-u();if(p("PLUS")||p("THE"))return u();if(p("SQUARE","ROOT","OF")||p("SQUARE","ROOT")||p("SQRT")||p("ROOT","OF")){l++;let f=u();return f<0&&h(),Math.sqrt(f)}return p("HALF","OF")||p("HALF")?(l++,u()/2):p("DOUBLE")||p("TWICE")?(l++,u()*2):p("TRIPLE")?(l++,u()*3):m()};let g=()=>{let f=u();for(;;){if(p("TIMES")||p("MULTIPLIED","BY")||p("X"))f*=u();else if(p("DIVIDED","BY")||p("OVER")){let E=u();E===0&&h("div0"),f/=E}else if(p("MOD")||p("MODULO")){let E=u();E===0&&h("div0"),f%=E}else if(p("PERCENT","OF"))f=f/100*u();else return f;l++}};c=()=>{let f=g();for(;;){if(p("PLUS")||p("ADDED","TO")||p("ADD"))f+=g();else if(p("MINUS")||p("TAKE","AWAY")||p("SUBTRACT"))f-=g();else return f;l++}};try{let f=c(),E=n[i];if(E==="LT"||E==="GT"||E==="LE"||E==="GE"||E==="EQ"||E==="NE"){i++;let y=c();l++,f=E==="LT"?f<y:E==="GT"?f>y:E==="LE"?f<=y:E==="GE"?f>=y:E==="EQ"?f===y:f!==y}return i!==n.length||typeof f=="number"&&!Number.isFinite(f)?null:{value:f,ops:l}}catch(f){return f.message==="div0"?{divideByZero:!0,value:NaN,ops:1}:null}}function vl(e,t){if(t!==void 0&&t!==""){let a=Math.max(0,Math.min(10,parseInt(t,10)||0));return String(Number(e.toFixed(a)))}return String(Math.round(e*1e8)/1e8)}function Lr(e){let t=[];return/IES$/.test(e)&&t.push(`${e.slice(0,-3)}Y`),/(CH|SH|X|SS|O)ES$/.test(e)&&t.push(e.slice(0,-2)),/[^S]S$/.test(e)&&t.push(e.slice(0,-1)),t}function Tr(e){let t=new Set,a=1;for(let s of e){let n=st(s,!1);n&&(t.add(n),a=Math.max(a,n.split(" ").length))}return{maxWords:a,phrases:t,sample:[...t][0]||"",match(s){return t.has(s)?s:Lr(s).find(n=>t.has(n))||""}}}var Ir={number:{maxWords:8,sample:"7",match(e){let t=e.split(" "),a=$n(t,0);return a&&a.next===t.length?e:""}},calculation:{maxWords:30,sample:"12 TIMES 12",match(e){let t=Cn(e);return t&&t.ops>0&&typeof t.value!="boolean"?e:""}}},Rn=new Set(["I","MY","ME","MINE","MYSELF"]),Sr=new Set(["YOU","YOUR","YOURS","YOURSELF"]),$t=e=>e.charCodeAt(0)===60,Yl=/^ZZSET([A-Z0-9_]+)ZZ$/,_o=[],Ul=new Set("SO WELL OK AND BUT UM UH HMM OH AH ALSO ACTUALLY ANYWAY LOL HAHA HA HEH HEHE AW AWW OOH WOW LISTEN LOOK HONESTLY BASICALLY SORRY JUST THEN YES".split(" ")),Cl=new Set("THEN THOUGH ANYWAY ANYWAYS AGAIN EXACTLY PLEASE TOO ALREADY ACTUALLY MATE BUDDY DUDE BRO MAN PAL HUH EH RIGHT LOL HAHA THANKS".split(" ")),Dl=new Set("ACTUALLY REALLY JUST EVEN BASICALLY LITERALLY HONESTLY TOTALLY SIMPLY".split(" ")),Wn={IS:"ARE",ARE:"IS",DO:"DOES",DOES:"DO",HAS:"HAVE",HAVE:"HAS",WAS:"WERE",WERE:"WAS"},Pl=[["TO","BE","HONEST"],["I","GUESS"],["I","SUPPOSE"],["I","THINK"],["BY","THE","WAY"],["AS","WELL"],["RIGHT","NOW"],["AT","THE","MOMENT"],["OR","NOT"],["OR","WHAT"],["FOR","ME"],["THANK","YOU"]];function Gl(e){let t=0,a=e.length;for(;;){if(a-t>1&&Cl.has(e[a-1])){a--;continue}let r=Pl.find(i=>a-t>i.length&&i.every((l,p)=>e[a-i.length+p]===l));if(r){a-=r.length;continue}if(a-t>1&&Ul.has(e[t])){t++;continue}break}let s=t===0&&a===e.length?e:e.slice(t,a),n=s.filter(r=>!Dl.has(r));return n.length&&n.length<s.length?n:s}var _l=new Set("SAD BAD AWFUL TERRIBLE HORRIBLE TIRED EXHAUSTED EXHAUSTING ANNOYING ANNOYED ANGRY UPSET HATE HATED HATES WORST WORSE SICK ILL HURT HURTS PAIN PAINFUL LONELY ALONE DEPRESSED DEPRESSING STRESSED STRESSFUL WORRIED SCARED AFRAID BORING BORED HARD DIFFICULT TOUGH ROUGH BROKE LOST FAILED FAIL CRY CRYING CRIED DIED DEAD UNFAIR RUDE MEAN NERVOUS ANXIOUS FRUSTRATED FRUSTRATING DISAPPOINTED DISAPPOINTING SUCKS SUCKED UGH UNFORTUNATELY STRUGGLING STUCK MISERABLE UNHAPPY HEARTBROKEN DUMPED FIRED NIGHTMARE DISASTER MESS MISSED FORGOT RUINED DREADFUL GROSS NASTY STUPID DRAINING LOUSY".split(" ")),Bl=new Set("GOOD GREAT AWESOME AMAZING WONDERFUL FANTASTIC LOVE LOVED LOVELY HAPPY EXCITED EXCITING FUN NICE BEST BEAUTIFUL BRILLIANT EXCELLENT GLAD PROUD WON WIN PASSED PERFECT DELICIOUS ENJOY ENJOYED COOL SWEET YAY FINALLY PROMOTED ENGAGED HOLIDAY VACATION PARTY RELAXING RELAXED THRILLED INCREDIBLE LUCKY GORGEOUS TASTY YUM YUMMY CELEBRATING".split(" "));function Fl(e){let t=0;return e.forEach((a,s)=>{let n=e[s-1]==="NOT"||e[s-1]==="NO"||e[s-1]==="NEVER"||e[s-2]==="NOT";_l.has(a)?t+=n?1:-1:Bl.has(a)&&(t+=n?-1:1)}),t>0?"positive":t<0?"negative":"neutral"}var Kl=new Set("WHO WHAT WHERE WHEN WHY HOW WHICH WHOSE DO DOES DID CAN COULD WILL WOULD SHOULD IS ARE AM WAS WERE HAVE HAS ANY".split(" ")),Vl=/ (I NEED|I WANT|I WOULD LIKE|I AM LOOKING FOR|I CANNOT|I COULD NOT|HOW DO I|HOW CAN I|CAN YOU HELP|PLEASE HELP|HELP ME|HELP WITH|PROBLEM|ISSUE|ERROR|BROKEN|NOT WORKING|DOES NOT WORK|LOCKED|COMPLAINT|MY (?:ORDER|ACCOUNT|ADDRESS|DELIVERY|PAYMENT|CARD|SUBSCRIPTION|BOOKING|PASSWORD|LOGIN|INVOICE|PARCEL|PACKAGE|REFUND|TICKET|APPOINTMENT|RESERVATION|PURCHASE)) /;function zl(e){let t=st(e,!1);return/^[A-Z]{4,}$/.test(t)&&(!/[AEIOUY]/.test(t)||/[BCDFGHJKLMNPQRSTVWXZ]{6,}/.test(t))?"gibberish":Vl.test(` ${t} `)?"request":/\?\s*$/.test(String(e))||Kl.has(t.split(" ")[0])?"question":"statement"}function vr(e){if(!e||e.type==="text")return"";let t=Object.entries(e.attrs||{}).map(([a,s])=>` ${a}="${s}"`).join("");return`<${e.tag}${t}>${(e.children||[]).map(vr).join("")}`}function kt(e){return e?e.type==="text"?e.value:(e.children||[]).map(kt).join(""):""}function ka(e,t,a=0,s=0,n=[],r=null){if(a===e.length&&s===t.length)return n;if(a>=e.length)return null;let i=e[a];if(i==="#"||i==="^"){for(let p=s;p<=t.length;p++){let h=t.slice(s,p).join(" "),c=ka(e,t,a+1,p,[...n,h],r);if(c)return c}return null}if(i==="_"||i==="*"){if(s>=t.length)return null;for(let p=s+1;p<=t.length;p++){let h=t.slice(s,p).join(" "),c=ka(e,t,a+1,p,[...n,h],r);if(c)return c}return null}if(s>=t.length)return null;if($t(i)){let p=r?r(i.slice(1,-1)):null;if(!p)return null;for(let h=Math.min(t.length,s+p.maxWords);h>s;h--){let c=p.match(t.slice(s,h).join(" "));if(!c)continue;let o=ka(e,t,a+1,h,[...n,c],r);if(o)return o}return null}return(i.startsWith("$")?i.slice(1):i)===t[s]?ka(e,t,a+1,s+1,n,r):null}var za=new Set(["*","_","#","^"]);function ql(e){let t=0,a=0;for(let r of e.patTokens)r.startsWith("$")?t=t*8+7:r==="#"?t=t*8+6:r==="_"?t=t*8+5:r==="^"?t=t*8+2:r==="*"?t=t*8+1:$t(r)?t=t*8+3:t=t*8+4,$t(r)?a+=.5:za.has(r)||(a+=1);let s=e.topic!=="*"?1e12:0,n=e.that!=="*"?1e9:0;return s+n+a*1e6+t}var Yr=new Set("A AN THE IS ARE AM BE DO DOES DID YOU YOUR I ME MY WE OUR IT ITS TO OF IN ON AT FOR AND OR SO WHAT WHEN WHERE WHO HOW WHY CAN COULD WOULD WILL SHOULD PLEASE TELL HAVE HAS THAT THIS THERE ANY SOME WITH ABOUT".split(" ")),br=new Set([...Yr].concat("GET GOT NEED WANT KNOW MUCH MANY LONG TAKE MAKE GO GOING JUST REALLY VERY ALSO TOO NOW THEN THAN FROM BY AS IF BUT NOT NO YES OK HI HELLO HEY THANK THANKS MORE MOST ALL EACH EVERY ANYTHING SOMETHING THING STUFF WAY KIND SORT LOT BIT GIVE SHOW SEE LOOK USE BEEN WAS WERE MIGHT MAY MUST LET HERE WHICH THEY THEM THEIR HE SHE HIS HER US ONE GOOD GREAT NEW RIGHT SURE QUESTION WONDER ASK SAY OUT UP DOWN OFF INTO OVER AGAIN STILL YET EVER NEVER ALWAYS TODAY LIKE DOING DONE HAD BEING DOE ACTUALLY MAYBE QUICK".split(" ")));function Xt(e){let t=e;if(t.length<=3)return t;let a=(s,n,r="")=>t.endsWith(s)&&t.length-s.length>=n?(t=t.slice(0,t.length-s.length)+r,!0):!1;return!a("IES",2,"Y")&&!/(SS|US|IS)$/.test(t)&&a("S",3),a("ION",4)||a("MENT",3)||a("ING",3)||a("ED",4)||a("LY",4),t.length>5&&a("Y",4),t.length>6&&a("ER",4),t.length>4&&t[t.length-1]===t[t.length-2]&&!/[AEIOU]/.test(t[t.length-1])&&(t=t.slice(0,-1)),t.length>4&&a("E",3),t}var jl={price:"price prices pricing cost costs fee fees charge charges rate rates expensive cheap affordable quote tariff",shipping:"ship ships shipping shipped shipment delivery deliver delivered delivering postage freight courier dispatch parcel arrive arrives arrival",returns:"return returns returning refund refunds refunded exchange exchanges reimburse reimbursement",hours:"hours open opening opens close closes closing closed shut shuts schedule",contact:"contact contacting reach message enquiry inquiry enquire inquire",phone:"phone telephone call calling ring mobile",talk:"talk talking speak speaking chat chatting",email:"email emails emailing mail",location:"location located locations address where directions based office offices store stores shop shops branch branches showroom",buy:"buy buying bought purchase purchasing order ordering orders checkout",discount:"discount discounts coupon coupons promo promotion promotions sale sales deal deals voucher vouchers offer offers",account:"account accounts login signin signup register registration password profile",cancel:"cancel cancelling canceling cancellation cancelled unsubscribe terminate",payment:"pay paying paid payment payments card cards paypal invoice invoices billing bill visa mastercard",trial:"trial trials demo demos sample samples preview",support:"support help assist assistance helpdesk troubleshoot troubleshooting",warranty:"warranty warranties guarantee guaranteed guarantees",tracking:"track tracking tracked status",install:"embed embedding install installing installation integrate integration setup plugin widget",download:"download downloads downloading export exporting",docs:"docs documentation guide guides manual tutorial tutorials instructions",about:"about company business team story mission history",security:"safe safety secure security privacy private gdpr",jobs:"job jobs career careers hiring vacancy vacancies employment recruit recruiting",size:"size sizes sizing fit fits measurement measurements",features:"feature features function functions capability capabilities",stock:"stock available availability inventory"},Xo=new Map,$l=new Map;for(let[e,t]of Object.entries(jl)){let a=t.toUpperCase().split(" ");$l.set(e,a);for(let s of a)Xo.has(Xt(s))||Xo.set(Xt(s),e)}var Xl=[[["MONEY","BACK"],"REFUND"],[["GET","IN","TOUCH"],"CONTACT"],[["LOG","IN"],"LOGIN"],[["SIGN","IN"],"LOGIN"],[["SIGN","UP"],"REGISTER"],[["SET","UP"],"SETUP"],[["SEND","BACK"],"RETURN"],[["HOW","FAR"],"LOCATION"],[["IN","STOCK"],"AVAILABLE"],[["OPENING","TIMES"],"HOURS"],[["ON","MY","SITE"],"EMBED"],[["ON","MY","WEBSITE"],"EMBED"],[["ON","MY","PAGE"],"EMBED"],[["TO","MY","SITE"],"EMBED"],[["TO","MY","WEBSITE"],"EMBED"],[["HOW","MUCH"],"PRICE",["IS","DOES","DO","ARE","FOR","WOULD","WILL","IT","THAT","THIS"]]];function Jl(e){let t=e;for(let[a,s,n]of Xl)for(let r=0;r+a.length<=t.length;r++){if(!a.every((l,p)=>t[r+p]===l))continue;let i=t[r+a.length];n&&i!==void 0&&!n.includes(i)||(t=[...t.slice(0,r),s,...t.slice(r+a.length)])}return t}function jt(e){if(br.has(e))return"";let t=Xt(e);if(t.length<2||br.has(t))return"";let a=Xo.get(t);return a?`@${a}`:t}function Ql(e){let t=e.join(" ").toLowerCase();return t?t[0].toUpperCase()+t.slice(1):""}var Zl=new Set("star thatstar topicstar bot get set think srai sr random li condition uppercase lowercase formal sentence person person2 date time size version input that request response br emote gesture reply button chip suggest oob chips map calc explode count daysuntil fallback try name value text postback persona showcase tour stop".split(" ")),Hr="";function wr(e,t,a){if(Math.abs(e.length-t.length)>a)return a+1;let s=e.length+1,n=t.length+1,r=null,i=Array.from({length:n},(l,p)=>p);for(let l=1;l<s;l++){let p=[l],h=l;for(let c=1;c<n;c++){let o=e[l-1]===t[c-1]?0:1,d=Math.min(i[c]+1,p[c-1]+1,i[c-1]+o);r&&l>1&&c>1&&e[l-1]===t[c-2]&&e[l-2]===t[c-1]&&(d=Math.min(d,r[c-2]+1)),p[c]=d,d<h&&(h=d)}if(h>a)return a+1;r=i,i=p}return i[n-1]}var xl=new Set("AND OR WHAT ABOUT HOW IS ARE THERE ANY DO YOU HAVE GOT A AN THE ALSO TOO THEN PLEASE FOR OF IN WITH".split(" ")),ec=new Set(["IT","THEY","THEM","THAT","THOSE","THIS","THESE","ONE","THERE"]);function Nr(e,t){for(let a=Math.min(e.maxWords,t.length);a>=1;a--)for(let s=0;s+a<=t.length;s++){let n=e.match(t.slice(s,s+a).join(" "));if(n)return{member:n,rest:[...t.slice(0,s),...t.slice(s+a)]}}return null}function tc(e){let t=e.category;return t.layer!=="base"||t.firm||t.literalOnly||t.that==="*"&&t.topic==="*"?!1:e.stars.some(a=>a.split(" ").some(s=>s&&jt(s)!==""))}var ac=e=>e.layer==="custom"&&(e.keywordIdeas.size>0||!e.patTokens.some(t=>t==="*"||t==="_")),kn=e=>e.layer==="custom"||e.requires.length>0;function Bo(e){return String(e||"").trim().toLowerCase().replace(/\s+/g," ")}var B,Fo,Ur,Dn,qa,Ko,mo,Vo,fo,Pn,zo,qo,Gn,jo,ut,Cr,_n,Dr,Bn,go,Pr,Gr,_r,Br,Eo,Fn,Ke,Kn,$a=class{constructor(t={}){pa(this,B);this.botProps={name:"Aria",role:"Website Companion",company:"bot.computer",website:"https://bot.computer",...t.botProps||{}},this.vars=new Map([["topic","*"]]),this.layers={custom:[],base:[]},this.categories=[],this.vocabulary=new Set,this.quickChips=[],this.xmlBotProps={},this.lastBotThat="",this.history=[],this.fallbackStreak=0,this._randomMemory=new WeakMap,this._defs={custom:{sets:new Map,maps:new Map},base:{sets:new Map,maps:new Map}},this._followups={},this._justVaried=!1,this._resolvingEntity=!1,this._setLookup=a=>F(this,B,qa).call(this,a),this._sources={custom:"",base:""},this._idf=new Map,this._answerIds=new Map,this.persona=null,this._personaConfig=null,this._personaXml=null,this._personaSays=new Map,this._personaMemory={},this.random=typeof t.random=="function"?t.random:Math.random,t.baseXml&&this.loadBaseXML(t.baseXml),t.xml&&this.loadXML(t.xml),t.persona&&this.setPersona(t.persona)}setPersona(t){return this._personaConfig=Wa(t),F(this,B,Fo).call(this),this.persona}setBotProps(t){Object.assign(this.botProps,t||{});try{if(this._sources.base){let a=F(this,B,Dn).call(this,this._sources.base);this.layers.base=a.categories,this._defs.base={sets:a.sets,maps:a.maps}}if(this._sources.custom){let a=F(this,B,zo).call(this,this._sources.custom,"custom");this.layers.custom=a.categories,this._defs.custom={sets:a.sets,maps:a.maps},this.quickChips=a.quickChips,this.xmlBotProps=a.xmlBotProps,this._personaXml=a.persona,F(this,B,Fo).call(this)}F(this,B,qo).call(this)}catch{}}sampleStars(t){let a=[];for(let s of t.patTokens)s==="*"||s==="_"?a.push("\u2026"):s==="#"||s==="^"?a.push(""):$t(s)&&a.push(F(this,B,qa).call(this,s.slice(1,-1))?.sample||"\u2026");return a}samplePhrase(t){let a=[];for(let s of t.patTokens)if(s==="*"||s==="_")a.push("something");else{if(s==="#"||s==="^")continue;if($t(s)){let n=F(this,B,qa).call(this,s.slice(1,-1));if(!n||!n.sample)return"";a.push(n.sample)}else a.push(s.replace(/^\$/,""))}return a.join(" ").toLowerCase()}previewTemplate(t,a=[]){let s=n=>{if(n.type==="text")return n.value;let r=()=>(n.children||[]).map(s).join("");switch(n.tag){case"star":{let i=a[Math.max(1,parseInt(n.attrs.index||"1",10))-1];return i===void 0?"\u2026":i.toLowerCase()}case"map":{let i=F(this,B,Ko).call(this,(n.attrs.name||"").toLowerCase()),l=st(r(),!1);return i&&i.entries.get(l)||"\u2026"}case"srai":return`\u2192 ${r().toLowerCase()}`;case"bot":{let i=(n.attrs.name||"").toLowerCase();return String(this.botProps[i]||this.xmlBotProps?.[i]||"\u2026")}case"random":case"condition":{let i=(n.children||[]).find(l=>l.type==="element"&&l.tag==="li");return i?s(i):r()}case"tour":{let i=Mn(n)[0];return i?" "+i.children.map(s).join(""):""}case"stop":case"think":case"emote":case"gesture":case"showcase":case"reply":case"button":case"chip":case"chips":case"suggest":case"oob":return"";case"thatstar":case"topicstar":case"get":case"input":case"that":case"request":case"response":case"sr":case"try":case"date":case"time":case"calc":case"count":case"daysuntil":return"\u2026";case"fallback":case"name":case"value":return"";case"br":return" ";default:return r()}};return Jt(s(t)).replace(/\s+/g," ").replace(/\s+([,.!?;:])/g,"$1").trim()}lint(t=12){let a=[],s=(h,c)=>{a.length<t&&!a.some(o=>o.line===h&&o.message===c)&&a.push({line:h,message:c})},n={activeTopic:"*",activeTopicWords:["*"],lastThatWords:[]},r=new Map,i=new Set,l=(h,c)=>{for(let o of h.matchAll(/\[([^\]\n]{1,60})\]/g)){let d=o[1].trim();if(!(!/^[a-zA-Z_/]/.test(d)||/(^|[,\s])\/?sing\b/i.test(d)))for(let u of d.split(/[,\s]+/).filter(Boolean)){let m=u.split("=")[0].toLowerCase();if(Rr(u)||Un(u)||Yn.has(m)||Object.prototype.hasOwnProperty.call(vn,m)||u.includes("="))continue;let g=[...Mr,...zn].find(f=>wr(f,m.replace(/[-_]/g,""),2)<=(m.length>4?2:1));s(c,`[${u}] is not an action or voice style, so it is left out.${g?` Did you mean [${g}]?`:""}`)}}},p=(h,c,o)=>{if(h.type==="text"){l(h.value,c);return}let d=h.line||c;if(!Zl.has(h.tag))s(d,`<${h.tag}> is not a tag this engine supports. Its contents are used as plain text.`);else if(h.tag==="tour")Mn(h).length||s(d,"<tour> needs at least one <stop> with a valid target."),h.children.some(u=>u.type==="element"?u.tag!=="stop":u.value.trim())&&s(d,"Put each tour explanation and its gestures inside a <stop>.");else if(h.tag==="stop")o!=="tour"&&s(d,"<stop> belongs directly inside a <tour>."),ja(h.attrs.target)||s(d,'<stop> needs a literal target such as "pricing". Use a letter followed by letters, digits, underscores or hyphens, up to 64 characters total.');else if(h.tag==="showcase")ja(h.attrs.target)?h.children.some(u=>u.type==="element"||u.value.trim())&&s(d,"Only the target attribute of <showcase> is used. Put speech and gestures beside the tag."):s(d,'<showcase> needs a target such as "pricing". Start with a letter and use up to 64 letters, digits, underscores or hyphens.');else if(h.tag==="bot"){let u=(h.attrs.name||"").toLowerCase();u&&!String(this.botProps[u]||this.xmlBotProps?.[u]||"").trim()&&s(d,`<bot name="${u}"/> has no value yet, so nothing is said there.`)}else if(h.tag==="srai"&&(h.children||[]).every(u=>u.type==="text")){let u=st(kt(h),!1),m=u.split(" ");if(u&&!F(this,B,ut).call(this,m,!1,n)&&!F(this,B,ut).call(this,m,!1,n,!0)){let g=kt(h).replace(/\s+/g," ").trim();s(d,`<srai>${g}</srai> does not lead to any rule, so this answer falls through to the fallback.`)}}h.tag==="map"&&h.attrs.name&&!F(this,B,Ko).call(this,h.attrs.name.toLowerCase())&&s(d,`The map "${h.attrs.name}" is not defined, so nothing is looked up there.`);for(let u of h.children||[])p(u,d,h.tag)};for(let h of this.layers.custom){for(let d of h.sets)F(this,B,qa).call(this,d)||s(h.line,`The set "${d}" is not defined, so the pattern "${h.pattern}" can never match.`);let c=`${h.pattern}${h.that}${h.topic}`,o=r.get(c);if(o&&o.template!==h.template?s(h.line,`The pattern "${h.pattern}" is already used on line ${o.line}. Only one of them can answer.`):o||r.set(c,h),!i.has(h.template)){i.add(h.template);for(let d of h.template.children||[])p(d,h.template.line||h.line)}}return a}warmUp(){for(let t of["hello there","what are your fees for postage please","xyzzy plugh frobnicate","i like hiking a lot"])try{this.resolve(t)}catch{}}exportSession(){let{frame:t,entity:a,result:s}=this._followups;return{vars:[...this.vars.entries()],lastBotThat:this.lastBotThat,history:this.history.slice(-12),fallbackStreak:this.fallbackStreak,followups:{frame:t?{...t,stars:[...t.stars]}:null,entity:a?{...a}:null,result:s?{...s}:null,justVaried:this._justVaried}}}importSession(t){if(!(!t||typeof t!="object"))try{this.resetSession(),Array.isArray(t.vars)&&(this.vars=new Map(t.vars.filter(l=>Array.isArray(l)&&l.length===2))),this.vars.has("topic")||this.vars.set("topic","*"),typeof t.lastBotThat=="string"&&(this.lastBotThat=t.lastBotThat),Array.isArray(t.history)&&(this.history=t.history.slice(-12).filter(l=>typeof l?.user=="string"&&typeof l?.bot=="string")),this.fallbackStreak=Number(t.fallbackStreak)||0;let{frame:a,entity:s,result:n,justVaried:r}=t.followups||{},i=(l,p)=>Number.isInteger(l?.remaining)&&l.remaining>=0&&l.remaining<=p;i(a,2)&&(a.layer==="custom"||a.layer==="base")&&typeof a.pattern=="string"&&Array.isArray(a.stars)&&a.stars.every(l=>typeof l=="string")&&(this._followups.frame={pattern:a.pattern,layer:a.layer,stars:[...a.stars],remaining:a.remaining}),i(s,3)&&typeof s.phrase=="string"&&(this._followups.entity={phrase:s.phrase,remaining:s.remaining}),i(n,3)&&typeof n.value=="string"&&n.value.trim()&&Number.isFinite(Number(n.value))&&(this._followups.result={value:n.value,remaining:n.remaining}),this._justVaried=r===!0}catch{this.resetSession()}}resetSession(){this._followups={},this._justVaried=!1,this.vars.clear(),this.vars.set("topic","*"),this.lastBotThat="",this.history=[],this.fallbackStreak=0}loadXML(t){let a=F(this,B,zo).call(this,t,"custom");return this._sources.custom=String(t||""),this.layers.custom=a.categories,this._defs.custom={sets:a.sets,maps:a.maps},this.quickChips=a.quickChips,this.xmlBotProps=a.xmlBotProps,this._personaXml=a.persona,F(this,B,Fo).call(this),F(this,B,qo).call(this),{valid:!0,categories:a.categories.length,quickChips:a.quickChips,botProps:{...a.xmlBotProps,...this.botProps}}}loadBaseXML(t){let a=t?F(this,B,Dn).call(this,String(t)):{categories:[],sets:new Map,maps:new Map};return this.layers.base=a.categories,this._defs.base={sets:a.sets,maps:a.maps},this._sources.base=String(t||""),F(this,B,qo).call(this),{valid:!0,categories:this.layers.base.length}}resolve(t){let a=st(t,!1);if(!a)return null;let s=F(this,B,Gr).call(this,a.split(" ")).map(k=>F(this,B,Cr).call(this,k)).flatMap(k=>Ft($o,k)?$o[k].split(" "):[k]),n=F(this,B,jo).call(this),r=k=>k.layer==="custom"||k.literalOnly||k.firm||k.sets.length===k.patTokens.length||k.that!=="*"||k.topic!=="*",i=k=>{let Y=F(this,B,ut).call(this,k,!1,n),C=null;return Y&&tc(Y)&&(C=Y,Y=F(this,B,ut).call(this,k,!1,n,!1,!1,!0)),{hit:Y,followUp:C}},{hit:l,followUp:p}=i(s);if(l&&l.category.layer==="base"&&!l.category.firm&&l.category.that==="*"&&l.category.topic==="*"){let k=F(this,B,ut).call(this,s,!1,n,!1,!0,!1,ac);if(k)return{...k,kind:"exact"}}if(l&&r(l.category))return{...l,kind:"exact"};let h=Gl(s);if(h!==s){let k=i(h);if(k.hit&&r(k.hit.category))return{...k.hit,kind:"exact"};k.hit&&(s=h,l=k.hit,p=k.followUp||p)}let c=null;if(l&&(c=l,l=F(this,B,ut).call(this,s,!1,n,!1,!0),l))return{...l,kind:"exact"};let o=!!(c||p),d=Jl(s);if(l=(d!==s?F(this,B,ut).call(this,d,!1,n,!1,o):null)||F(this,B,Bn).call(this,d,n,o),l)return{...l,kind:"synonym"};if(s.some(k=>Ft(Wn,k))&&(l=F(this,B,ut).call(this,s.map(k=>Ft(Wn,k)?Wn[k]:k),!1,n,!1,o),l))return{...l,kind:"synonym"};let u=F(this,B,_n).call(this,d),m=d!==s?F(this,B,_n).call(this,s):null;for(let k of[m,u])if(k&&(l=F(this,B,ut).call(this,k,!1,n,!1,o)||F(this,B,Bn).call(this,k,n,o),l))return{...l,kind:"typo"};let g=u||d;if(l=F(this,B,Dr).call(this,g,n,o,u?.75:.6),l)return{...l,kind:"loose"};let f=F(this,B,Pr).call(this,g);if(f.hit)return{...f.hit,kind:"meaning",also:f.also?{...f.also,kind:"meaning"}:null};if(c)return{...c,kind:"exact"};if(p)return{...p,kind:"exact"};let E=this._followups.frame;if(E&&!this._resolvingEntity&&s.length<=6&&!s.some(k=>Rn.has(k))){let k=this.layers[E.layer].find(q=>q.pattern===E.pattern&&q.continuable&&q.sets.length===1&&(!q.requires.length||F(this,B,fo).call(this,q.requires))),Y=k&&F(this,B,qa).call(this,k.sets[0]),C=Y&&Nr(Y,s);if(C&&C.rest.every(q=>xl.has(q))){let q=k.patTokens.filter(Q=>za.has(Q)||$t(Q));if(E.stars.length===q.length){let Q=[...E.stars];return Q[q.findIndex($t)]=C.member,{category:k,stars:Q,thatStars:[],topicStars:[],kind:"followup"}}}}let y=this._followups.result;if(y&&!this._resolvingEntity){let k=s.findIndex(C=>C==="THAT"||C==="IT"),Y=k<0&&kl.has(h[0]);if(k>=0||Y){let C=Y?`${y.value} ${h.join(" ")}`:[...s.slice(0,k),String(y.value),...s.slice(k+1)].join(" "),q=Cn(C);if(q&&q.ops>0){this._resolvingEntity=!0;try{let Q=this.resolve(C);if(Q&&Q.kind!=="fallback")return{...Q,kind:"followup"}}finally{this._resolvingEntity=!1}}}}let w=this._followups.entity;if(w&&!this._resolvingEntity){let k=s.findIndex(Y=>ec.has(Y));if(k>=0){this._resolvingEntity=!0;try{let Y=this.resolve([...s.slice(0,k),w.phrase,...s.slice(k+1)].join(" "));if(Y&&Y.kind!=="fallback"&&Y.kind!=="chat"&&(kn(Y.category)||Y.category.sets.length>0))return{...Y,kind:"followup"}}finally{this._resolvingEntity=!1}}}return l=(h!==s?F(this,B,ut).call(this,h,!1,n,!0):null)||F(this,B,ut).call(this,s,!1,n,!0)||(d!==s?F(this,B,ut).call(this,d,!1,n,!0):null)||(u?F(this,B,ut).call(this,u,!1,n,!0):null),l?{...l,kind:"chat"}:(l=F(this,B,ut).call(this,s,!0,n),l?{...l,kind:"fallback",related:f.related}:null)}findMatch(t){let a=st(t,!1);return a?F(this,B,ut).call(this,a.split(" "),!0):null}reply(t){let a=String(t||"").trim();if(!a)return{speechText:"",displayText:"",chips:this.quickChips.slice(0,4),emote:null,showcase:"",tour:[],cues:[],cueWords:0,matchedPattern:null,matchedLayer:null,matchKind:"none"};let s=[],n=Or(a),r=n.length>1&&yl.has(st(n[0],!1)),i=r?1:0,l=(H,W,V)=>W&&W.kind!=="fallback"&&!s.some(ee=>ee.hit.category===W.category)?(s.push({text:H,hit:W,inputIndex:V}),!0):!1;for(let H=i;H<Math.min(n.length,i+4);H++){let W=r&&H===i?`${n[0].replace(/[.!?]+$/,"")} ${n[H]}`:n[H],V=W.split(/\s+(?:and|&|plus|also|but)\s+/i);if(V.length===2){let v=this.resolve(W),P=v?.category.patTokens;if(v?.kind==="exact"&&P.some(ae=>["AND","PLUS","ALSO","BUT"].includes(ae))&&!P.some(ae=>za.has(ae))){l(W,v,H);continue}let[X,oe]=V.map(ae=>this.resolve(ae)),$=ae=>ae&&ae.kind!=="fallback"&&!ae.category.isCatchAll;if($(X)&&$(oe)&&F(this,B,go).call(this,X.category)!==F(this,B,go).call(this,oe.category)){l(V[0],X,H),l(V[1],oe,H);continue}}let ee=this.resolve(W);l(W,ee,H),ee&&ee.also&&l(W,ee.also,H)}let p=!1,h=[];if(!s.length){let H=this.resolve(a);H&&s.push({text:a,hit:H,inputIndex:n.length-1}),p=!H||H.kind==="fallback",h=H&&H.related||[]}this.vars.set("didyoumean",h.length?"yes":"");let c=this.fallbackStreak;this.fallbackStreak=p?this.fallbackStreak+1:0,F(this,B,_r).call(this,a);let o={chips:[],emote:null,showcase:"",tour:null,streakBefore:c,inputs:n},d=[];for(let H of s.slice(0,3)){o.inputIndex=H.inputIndex;let W=F(this,B,Eo).call(this,H.hit,H.text,0,o).replace(/\s+/g," ").trim();W&&d.push(W)}let u=s.length===1&&s[0].hit.kind!=="fallback"&&o.answeredBy||s[0]?.hit||null;(u&&u.kind==="fallback"||o.fellBack)&&(p=!0),o.related&&o.related.length&&(h=o.related);let m=p?"":o.showcase,g=p?[]:o.tour||[];g[0]?.text&&d.push(g[0].text);let f=d.length||m||g.length?d.join(" "):`I'm not sure about that yet, but I'm happy to help with questions about ${this.botProps.company||"our site"}!`,E=String(this.vars.get("voicestyle")||"").trim().toLowerCase(),y=g.length?f:F(this,B,Br).call(this,f,{isFallback:p,first:u,plans:s,sideEffects:o,style:E}),w=H=>{let W=Oo(H&&E&&Yn.has(E)?`[${E}] ${H}`:H);return{speechText:W.speechText,displayText:Jt(H),cues:W.cues,cueWords:W.wordCount}},k=w(y),Y=g.map((H,W)=>({target:H.target,...W===0?k:w(H.text)})),C=Jt(f),q=Er(C);this.lastBotThat=q[q.length-1]||C,this.history.push({user:a,bot:C}),this.history.length>50&&this.history.shift();for(let[H,W]of Object.entries(this._followups))W.remaining===0?delete this._followups[H]:W.remaining--;!p&&u&&u.category.varies&&!s.some(H=>H.hit.category.replaysLastAsk||H.hit.category.that!=="*")&&this.vars.set("lastask",a);let Q=st(a,!1).split(" "),de=[...[...this._defs.base.maps.values()].map(H=>H.keys),...this._defs.custom.sets.values(),...[...this._defs.custom.maps.values()].map(H=>H.keys)];for(let H of de){let W=Nr(H,Q);W&&(this._followups.entity={phrase:W.member,remaining:3})}o.calcValue!==void 0&&(this._followups.result={value:o.calcValue,remaining:3}),this._justVaried=!!(!p&&u&&u.category.varies),!p&&u&&u.category.continuable&&u.category.sets.length===1&&u.stars&&(this._followups.frame={layer:u.category.layer,pattern:u.category.pattern,stars:[...u.stars],remaining:2});let D=new Set,M=o.chips.filter(H=>!D.has(H.label)&&D.add(H.label)).slice(0,5),A=M;if(p){let H=M.length?M:this.quickChips.map(V=>({label:V,query:V})),W=new Set(h.map(V=>V.label.toLowerCase()));A=[...h,...H.filter(V=>!W.has(V.label.toLowerCase()))].slice(0,4)}let I=k.cues.find(H=>H.type==="action");return{...k,chips:A,emote:I?I.name:null,showcase:m,tour:Y,matchedPattern:u?u.category.pattern:null,matchedLayer:u?u.category.layer:null,matchKind:o.fellBack?"fallback":u?u.kind:"none"}}};B=new WeakSet,Fo=function(){let t=this._personaXml,a=t&&t.fields.id&&this._personaConfig&&t.fields.id!==this._personaConfig.id?{}:this._personaConfig||{};if(this.persona=t?Wa({...a,...t.fields}):this._personaConfig,this._personaSays=new Map,this._personaMemory={},!!this.persona){for(let[s,n]of Object.entries(lr(this.persona))){let r=F(this,B,Ur).call(this,n);r&&this._personaSays.set(s,r)}if(t)for(let[s,n]of Object.entries(t.says))this._personaSays.set(s,{type:"element",tag:"random",attrs:{},children:n})}},Ur=function(t){let a=n=>`<random>${n.map(r=>`<li>${r}</li>`).join("")}</random>`,s=n=>gr(n).children.find(r=>r.type==="element"&&r.tag==="random")||null;try{return s(a(t.map(Nn)))}catch{try{return s(a(t.map(n=>Nn(ml(n)))))}catch{return null}}},Dn=function(t){let a=r=>String(this.botProps[r]??"").trim(),s=_o.find(r=>r.xml===t&&Object.entries(r.props).every(([i,l])=>a(i)===l));if(s)return s.parsed;let n=F(this,B,zo).call(this,t,"base");return _o.unshift({xml:t,props:n.patternProps,parsed:n}),_o.length>4&&(_o.length=4),n},qa=function(t){for(let a of[this._defs.custom,this._defs.base]){let s=a.sets.get(t);if(s)return s;let n=a.maps.get(t);if(n)return n.keys}return Ft(Ir,t)?Ir[t]:null},Ko=function(t){return this._defs.custom.maps.get(t)||this._defs.base.maps.get(t)||null},mo=function(t,a,s){if(t.attrs&&t.attrs[a]!==void 0)return t.attrs[a];let n=(t.children||[]).find(r=>r.type==="element"&&r.tag===a);return n?F(this,B,Ke).call(this,n.children,s).trim():void 0},Vo=function(t,a){return(t.children||[]).filter(s=>!(s.type==="element"&&a.includes(s.tag)))},fo=function(t){return t.some(a=>String(this.botProps[a]||this.xmlBotProps?.[a]||"").trim()!=="")},Pn=function(t){if(t.type==="text")return t.value;if(t.tag==="bot"){let a=String(this.botProps[(t.attrs.name||"").toLowerCase()]??"").trim();return this._patternProps&&(this._patternProps[(t.attrs.name||"").toLowerCase()]=a),a?` ${a} `:Hr}if(t.tag==="set"){let a=(t.attrs.name||kt(t)).trim().toUpperCase().replace(/[^A-Z0-9_]+/g,"_");return a?` ZZSET${a}ZZ `:""}return(t.children||[]).map(a=>F(this,B,Pn).call(this,a)).join("")},zo=function(t,a){let s=gr(t),n=s.children.find(u=>u.type==="element"&&u.tag==="aiml")||s,r=[],i=[],l={},p=new Map,h=new Map,c=null;this._patternProps={};let o=(u,m="*")=>{let g=[],f=null,E=null;for(let M of u.children||[])M.type==="element"&&(M.tag==="pattern"?g.push(M):M.tag==="that"?f=M:M.tag==="template"&&(E=M));if(!g.length||!E)return;let y=vr(E),w=String(u.attrs.requires||"").split("|").map(M=>M.trim().toLowerCase()).filter(Boolean),k=new Set(st(Jt(kt(E)),!1).split(" ").map(jt).filter(Boolean).slice(0,60)),Y=(E.children||[]).filter(M=>M.type!=="text"||M.value.trim()),C=Y.length===1&&Y[0].tag==="srai"&&(Y[0].children||[]).every(M=>M.type==="text")?st(kt(Y[0]),!1):"",q=f&&st(kt(f),!0)||"*",Q=q.split(" ").filter(Boolean),de=st(m,!0)||"*",D=de.split(" ").filter(Boolean);for(let M of g){let A=F(this,B,Pn).call(this,M),I=A.includes("|")?A.split("|"):[A];for(let H of I){if(H.includes(Hr))continue;let W=st(H,!0);if(!W)continue;let V=W.split(" ").filter(Boolean).map(P=>{let X=Yl.exec(P);return X?`<${X[1].toLowerCase()}>`:P}),ee=V.filter(P=>!za.has(P)&&!$t(P)).map(P=>P.startsWith("$")?P.slice(1):P),v={pattern:V.join(" "),patTokens:V,sets:V.filter($t).map(P=>P.slice(1,-1)),late:u.attrs.late==="true",firm:u.attrs.firm==="true",personaOff:u.attrs.persona==="off",varies:/<random\b/i.test(y),continuable:q==="*"&&de==="*"&&(/<map\b/i.test(y)||!/<think\b/i.test(y)),that:q,thatTokens:Q,topic:de,topicTokens:D,template:E,line:u.line||1,start:u.start??-1,layer:a,literals:ee,literalOnly:ee.length===V.length,replaysLastAsk:/<get name="lastask"/i.test(y),stems:ee.map(Xt),looseKeys:ee.map(P=>jt(P)||Xt(P)),requires:w,keywordIdeas:new Set(ee.map(jt).filter(Boolean)),answerIdeas:k,needsStar:/<(star|sr|thatstar|topicstar)\b/i.test(y),selfMatching:!V.some(P=>P==="*"||P==="_"||$t(P)),aliasOf:C,isCatchAll:V.every(P=>za.has(P))&&q==="*"&&de==="*"};v.score=ql(v),r.push(v)}}};for(let u of n.children||[])if(u.type==="element"){if(u.tag==="bot"||u.tag==="property"||u.tag==="meta"){let m=u.attrs.name||u.attrs.key,g=u.attrs.value??kt(u).trim();m&&g&&(m.toLowerCase()==="chip"||m.toLowerCase()==="suggest"?i.push(g):l[m.toLowerCase()]=g)}else if(u.tag==="chips"||u.tag==="suggestions"){for(let m of u.children||[])if(m.type==="element"){let g=kt(m).trim();g&&i.push(g)}}else if(u.tag==="set"&&u.attrs.name){let m=(u.children||[]).filter(f=>f.type==="element").map(f=>kt(f)),g=m.length?m:kt(u).split(/[,;\n]+/);p.set(u.attrs.name.toLowerCase(),Tr(g))}else if(u.tag==="map"&&u.attrs.name){let m=new Map,g=(f,E)=>{let y=st(f,!1);y&&String(E).trim()&&m.set(y,String(E).trim())};for(let f of u.children||[])if(f.type==="element")g(f.attrs.key??f.attrs.name??"",kt(f));else for(let E of f.value.split(/\n+/)){let y=E.search(/[:=]/);y>0&&g(E.slice(0,y),E.slice(y+1))}h.set(u.attrs.name.toLowerCase(),{entries:m,keys:Tr([...m.keys()])})}else if(u.tag==="persona")c=mr(u,kt);else if(u.tag==="category")o(u,"*");else if(u.tag==="topic"){let m=u.attrs.name||"*";for(let g of u.children||[])g.type==="element"&&g.tag==="category"&&o(g,m)}}let d=this._patternProps;return this._patternProps=null,{categories:r,quickChips:i,xmlBotProps:l,sets:p,maps:h,patternProps:d,persona:c}},qo=function(){this.categories=[...this.layers.custom,...this.layers.base].sort((i,l)=>l.score-i.score);let t=new Set;for(let i of this.categories){for(let l of i.literals)t.add(l);for(let l of i.thatTokens)za.has(l)||t.add(l)}for(let i of[this._defs.custom,this._defs.base])for(let l of[...i.sets.values(),...[...i.maps.values()].map(p=>p.keys)])for(let p of l.phrases)for(let h of p.split(" "))t.add(h);this.vocabulary=t;let a=new Map;for(let i of t){let l=jt(i);l&&(a.has(l)||a.set(l,[]),a.get(l).push(i))}this._wordsByIdea=a;let s=new Map,n=new Set;for(let i of this.categories)if(i.keywordIdeas.size){n.add(i.template);for(let l of i.keywordIdeas)s.has(l)||s.set(l,new Set),s.get(l).add(i.template)}let r=n.size;this._idf=new Map([...s].map(([i,l])=>[i,Math.log(1+r/(1+l.size))])),this._answerIds=new Map},Gn=function(t,a){let s=[];if(t.topic!=="*"&&(a.activeTopic==="*"||(s=ka(t.topicTokens,a.activeTopicWords),!s)))return null;let n=[];return t.that!=="*"&&(!a.lastThatWords.length||(n=ka(t.thatTokens,a.lastThatWords),!n))?null:{topicStars:s,thatStars:n}},jo=function(){let t=st(this.vars.get("topic")||"*",!1)||"*",a=st(this.lastBotThat||"",!1);return{activeTopic:t,activeTopicWords:t==="*"?["*"]:t.split(" "),lastThatWords:a?a.split(" "):[]}},ut=function(t,a,s=F(this,B,jo).call(this),n=!1,r=!1,i=!1,l=null){let p=new Set(t);for(let h of this.categories){if((h.isCatchAll?!a||n:h.late!==n)||r&&!kn(h)||i&&(h.that!=="*"||h.topic!=="*")||l&&!l(h))continue;let c=!0;for(let u of h.literals)if(!p.has(u)){c=!1;break}if(!c||h.requires.length&&!F(this,B,fo).call(this,h.requires))continue;let o=F(this,B,Gn).call(this,h,s);if(!o)continue;let d=ka(h.patTokens,t,0,0,[],this._setLookup);if(d)return{category:h,stars:d,thatStars:o.thatStars,topicStars:o.topicStars}}return null},Cr=function(t){if(!/([A-Z])\1\1/.test(t))return t;let a=t.match(/([A-Z])\1*/g)||[t],s=a.map((n,r)=>n.length>=3?r:-1).filter(n=>n>=0).slice(0,4);for(let n=0;n<1<<s.length;n++){let r=a.map((i,l)=>{let p=s.indexOf(l);return p<0?i.length>=3?i[0]:i:n>>p&1?i[0]+i[0]:i[0]}).join("");if(this.vocabulary.has(r))return r}return a.map(n=>n.length>=3?n[0]:n).join("")},_n=function(t){let a=!1,s=t.map(n=>{if(n.length<4||this.vocabulary.has(n)||/\d/.test(n)||Xo.has(Xt(n))||this._wordsByIdea.has(jt(n)))return n;let r=n.length>=8?2:1,i="",l=r+1,p=!1;for(let h of this.vocabulary){if(h[0]!==n[0]||h.length<3)continue;let c=wr(n,h,r);c<l?(i=h,l=c,p=!1):c===l&&c<=r&&(p=!0)}return i&&!p?(a=!0,i):n});return a?s:null},Dr=function(t,a=F(this,B,jo).call(this),s=!1,n=.6){let r=new Set(t.map(c=>jt(c)||Xt(c))),i=[...new Set(t.map(jt).filter(Boolean))],l=t.some(c=>Rn.has(c)),p=t.some(c=>Sr.has(c)),h=null;for(let c of this.categories){if(!c.literalOnly||c.late||c.stems.length<2||t.length>c.stems.length+2||!c.keywordIdeas.size||s&&!kn(c)||c.requires.length&&!F(this,B,fo).call(this,c.requires)||i.some(w=>!c.keywordIdeas.has(w)))continue;let o=c.literals.some(w=>Rn.has(w)),d=c.literals.some(w=>Sr.has(w));if(l&&!o&&d||p&&!d&&o)continue;let u=0,m=0,g=0;for(let w=0;w<c.stems.length;w++){let k=r.has(c.looseKeys[w]);k&&u++,Yr.has(c.stems[w])||(m++,k&&g++)}if(!m||g<m)continue;let f=u/c.stems.length;if(f<n)continue;let E=F(this,B,Gn).call(this,c,a);if(!E)continue;let y=g*10+f;(!h||y>h.quality)&&(h={quality:y,hit:{category:c,stars:[],thatStars:E.thatStars,topicStars:E.topicStars}})}return h?h.hit:null},Bn=function(t,a,s=!1){let n=t.map(p=>{if(this.vocabulary.has(p))return null;let h=jt(p),c=h?this._wordsByIdea.get(h):null;if(!c||!c.length)return null;let o=Xt(p);return[...c].sort((d,u)=>+(Xt(u)===o)-+(Xt(d)===o)).slice(0,8)}),r=n.map((p,h)=>p?h:-1).filter(p=>p>=0);if(!r.length)return null;let i=p=>{let h=t.map((c,o)=>n[o]?n[o][p[o]||0]:c);return F(this,B,ut).call(this,h,!1,a,!1,s)},l=i({});for(let p=0,h=0;!l&&p<r.length&&h<20;p++)for(let c=1;!l&&c<n[r[p]].length&&h<20;c++,h++)l=i({[r[p]]:c});return l},go=function(t){if(!t.aliasOf)return t.template;if(!this._answerIds.has(t.aliasOf)){this._answerIds.set(t.aliasOf,t.template);let a=F(this,B,ut).call(this,t.aliasOf.split(" "),!1,{activeTopic:"*",activeTopicWords:["*"],lastThatWords:[]});this._answerIds.set(t.aliasOf,a?F(this,B,go).call(this,a.category):t.template)}return this._answerIds.get(t.aliasOf)},Pr=function(t){let a=[...new Set(t.map(jt).filter(Boolean))];if(!a.length)return{hit:null,related:[]};let s=3,n=a.map(d=>this._idf.get(d)??s),r=n.reduce((d,u)=>d+u,0),i=[];for(let d of this.categories){if(d.layer!=="custom"&&!d.requires.length||d.isCatchAll||d.that!=="*"||d.topic!=="*"||d.needsStar||!d.keywordIdeas.size||d.requires.length&&!F(this,B,fo).call(this,d.requires))continue;let u=0,m=0,g=0;if(a.forEach((E,y)=>{d.keywordIdeas.has(E)?(u+=n[y],m++,y<30&&(g|=1<<y)):d.answerIdeas.has(E)&&(u+=n[y]*.35)}),!m)continue;let f=(d.keywordIdeas.size-m)/d.keywordIdeas.size;i.push({cat:d,coverage:u/r-.3*f,hitMask:g,id:F(this,B,go).call(this,d)})}if(!i.length)return{hit:null,related:[]};i.sort((d,u)=>u.coverage-d.coverage||u.cat.score-d.cat.score);let l=[];for(let d of i)l.some(u=>u.id===d.id)||l.push(d);let[p,h]=l,c=l.filter(d=>d.coverage>=.3&&d.cat.selfMatching).slice(0,3).map(d=>({label:Ql(d.cat.literals),query:d.cat.literals.join(" ").toLowerCase()})),o=d=>({category:d.cat,stars:[],thatStars:[],topicStars:[]});return h&&p.coverage>=.3&&h.coverage>=.3&&p.coverage+h.coverage>=.8&&!(p.hitMask&h.hitMask)?{hit:o(p),also:o(h),related:c}:p.coverage>=.55&&(!h||p.coverage-h.coverage>=.12)?{hit:o(p),related:c}:{hit:null,related:c}},Gr=function(t){let a=st(this.botProps.name||"",!1).split(" ").filter(Boolean),s=a.length;if(!s||t.length<s)return t;let n=a.every((i,l)=>t[l]===i),r=a.every((i,l)=>t[t.length-s+l]===i);return t.length===s?n?["HELLO"]:t:n?t.slice(s):r?t.slice(0,-s):t},_r=function(t="",a=new Date){let s=a.getHours();this.vars.set("inputkind",zl(t)),this.vars.set("justvaried",this._justVaried?"yes":""),this.vars.set("mood",Fl(st(t,!1).split(" "))),this.vars.set("daypart",s>=5&&s<12?"morning":s>=12&&s<17?"afternoon":"evening"),this.vars.set("dayname",a.toLocaleDateString("en-US",{weekday:"long"})),this.vars.set("fallbackstreak",String(this.fallbackStreak)),this.vars.set("suggestions",this.quickChips.length?"yes":""),this.vars.set("personality",this.persona?this.persona.id:""),this.vars.set("callsyou",this.persona?this.persona.petName:"");for(let[n,r]of Object.entries({...this.xmlBotProps,...this.botProps}))this.vars.set(`bot_${n}`,String(r||this.xmlBotProps?.[n]||"").trim())},Br=function(t,{isFallback:a,first:s,plans:n,sideEffects:r,style:i}){if(!this.persona||r.plain)return t;let l=s?s.category:null,p=n.some(c=>c.hit.category.that!=="*"||c.hit.category.topic!=="*"),h=a?"fallback":r.personaSaid?"says":p?"context":l&&(l.layer==="custom"||l.requires.length)?"answer":"chat";return dr(t,this.persona,{kind:h,gentle:this.vars.get("mood")==="negative"||!!(l&&l.firm),varied:!!(l&&l.varies),voicestyle:i,memory:this._personaMemory,rng:this.random})},Eo=function(t,a,s,n){t.category.personaOff&&n&&(n.plain=!0);let r={input:a,stars:t.stars,thatStars:t.thatStars,topicStars:t.topicStars,depth:s,sideEffects:n};return F(this,B,Ke).call(this,t.category.template.children,r)},Fn=function(t,a,s){if(a>22)return"";let n=this.resolve(t);return n?(s.answeredBy=n,n.kind==="fallback"&&!s.fellBack&&(s.fellBack=!0,this.fallbackStreak=(s.streakBefore||0)+1,this.vars.set("fallbackstreak",String(this.fallbackStreak)),s.related=n.related||[],this.vars.set("didyoumean",s.related.length?"yes":"")),F(this,B,Eo).call(this,n,t,a,s)):""},Ke=function(t,a){let s="";for(let n of t||[])s+=F(this,B,Kn).call(this,n,a);return s},Kn=function(t,a){if(!t)return"";if(t.type==="text")return t.value;let s=t.tag,n=t.attrs||{};switch(s){case"star":{let r=Math.max(1,parseInt(n.index||"1",10))-1;return(a.stars[r]||"").toLowerCase().replace(/(\d) point (?=\d)/g,"$1.")}case"thatstar":{let r=Math.max(1,parseInt(n.index||"1",10))-1;return(a.thatStars[r]||"").toLowerCase()}case"topicstar":{let r=Math.max(1,parseInt(n.index||"1",10))-1;return(a.topicStars[r]||"").toLowerCase()}case"bot":{let r=(n.name||"").toLowerCase();return this.botProps[r]??this.xmlBotProps?.[r]??""}case"get":{let r=Bo(F(this,B,mo).call(this,t,"name",a)),i=this.vars.get(r);return i!==void 0&&i!==""?i:n.default??""}case"set":{let r=Bo(F(this,B,mo).call(this,t,"name",a)),i=F(this,B,Ke).call(this,F(this,B,Vo).call(this,t,["name"]),a).trim();return r&&this.vars.set(r,i),i}case"map":{let r=F(this,B,Ko).call(this,String(F(this,B,mo).call(this,t,"name",a)||"").toLowerCase());if(!r)return n.default??"";let i=st(F(this,B,Ke).call(this,F(this,B,Vo).call(this,t,["name"]),a),!1),l=Lr(i).find(p=>r.entries.has(p));return r.entries.get(i)??(l?r.entries.get(l):void 0)??n.default??""}case"calc":{let r=Cn(F(this,B,Ke).call(this,t.children,a));if(!r)return n.default??"";if(r.divideByZero)return"undefined";if(typeof r.value=="boolean")return String(r.value);let i=vl(r.value,n.round);return a.sideEffects.calcValue=i,i}case"count":{let r=$n(kr(F(this,B,Ke).call(this,t.children,a)),0);if(!r)return"";let i=Array.from({length:Math.max(1,Math.min(30,Math.round(r.value)))},(l,p)=>p+1);return n.down==="true"&&i.reverse(),i.join(", ")}case"explode":return[...F(this,B,Ke).call(this,t.children,a).replace(/\s+/g,"")].join(n.sep??" ");case"daysuntil":{let r=new Date;if(r.setHours(0,0,0,0),n.weekday){let p=["sunday","monday","tuesday","wednesday","thursday","friday","saturday"].indexOf(n.weekday.toLowerCase());return p<0?"":String((p-r.getDay()+7)%7)}let i=/^(\d{1,2})-(\d{1,2})$/.exec((n.date||F(this,B,Ke).call(this,t.children,a)).trim());if(!i)return"";let l=new Date(r.getFullYear(),Number(i[1])-1,Number(i[2]));return l<r&&l.setFullYear(r.getFullYear()+1),String(Math.round((l-r)/864e5))}case"fallback":{if(a.depth>20)return"";let r=a.sideEffects;r.fellBack||(r.fellBack=!0,this.fallbackStreak=(r.streakBefore||0)+1,this.vars.set("fallbackstreak",String(this.fallbackStreak)));let i=this.categories.find(p=>p.isCatchAll);if(!i)return"";let l={category:i,stars:[st(a.input,!1)],thatStars:[],topicStars:[]};return F(this,B,Eo).call(this,l,a.input,a.depth+1,r)}case"think":return F(this,B,Ke).call(this,t.children,a),"";case"persona":{let r=this._personaSays.get(String(n.say||"").trim().toLowerCase());return r?(a.sideEffects&&(a.sideEffects.personaSaid=!0),F(this,B,Kn).call(this,r,a)):F(this,B,Ke).call(this,t.children,a)}case"srai":{let r=F(this,B,Ke).call(this,t.children,a).trim();return r?F(this,B,Fn).call(this,r,a.depth+1,a.sideEffects):""}case"try":{let r=F(this,B,Ke).call(this,t.children,a).trim();if(!r||a.depth>20)return"";let i=this.resolve(r);return!i||i.kind==="fallback"?"":(a.sideEffects.answeredBy=i,F(this,B,Eo).call(this,i,r,a.depth+1,a.sideEffects))}case"sr":{let r=a.stars[0]||"";return r?F(this,B,Fn).call(this,r,a.depth+1,a.sideEffects):""}case"random":{let r=(t.children||[]).filter(p=>p.type==="element"&&p.tag==="li");if(!r.length)return"";let i=this._randomMemory.get(t);if(!i||!i.left.length){let p=r.map((h,c)=>c);for(let h=p.length-1;h>0;h--){let c=Math.floor(this.random()*(h+1));[p[h],p[c]]=[p[c],p[h]]}i&&p.length>1&&p[0]===i.last&&p.push(p.shift()),i={left:p,last:i?i.last:-1},this._randomMemory.set(t,i)}let l=i.left.shift();return i.last=l,F(this,B,Ke).call(this,r[l].children,a).trim()}case"condition":{let r=Bo(n.name),i=(this.vars.get(r)||"").trim().toLowerCase(),l=(h,c)=>c.trim()==="*"?h!=="":h===c.trim().toLowerCase();if(n.value!==void 0)return l(i,n.value)?F(this,B,Ke).call(this,t.children,a):"";let p=(t.children||[]).filter(h=>h.type==="element"&&h.tag==="li");for(let h of p){let c=h.attrs.name!==void 0?Bo(h.attrs.name):r,o=(this.vars.get(c)||"").trim().toLowerCase(),d=F(this,B,mo).call(this,h,"value",a);if(d===void 0||l(o,d))return F(this,B,Ke).call(this,F(this,B,Vo).call(this,h,["value"]),a)}return""}case"uppercase":return F(this,B,Ke).call(this,t.children,a).toUpperCase();case"lowercase":return F(this,B,Ke).call(this,t.children,a).toLowerCase();case"formal":return F(this,B,Ke).call(this,t.children,a).replace(/\b\w/g,r=>r.toUpperCase());case"sentence":{let r=F(this,B,Ke).call(this,t.children,a).trim();return r?r[0].toUpperCase()+r.slice(1):""}case"person":case"person2":return Rl(F(this,B,Ke).call(this,t.children,a));case"date":{let r=new Date;if(n.offset&&r.setDate(r.getDate()+(parseInt(n.offset,10)||0)),!n.format)return r.toLocaleDateString(void 0,{weekday:"long",month:"long",day:"numeric",year:"numeric"});let i=p=>String(p).padStart(2,"0"),l={A:r.toLocaleDateString("en-US",{weekday:"long"}),B:r.toLocaleDateString("en-US",{month:"long"}),d:String(r.getDate()),Y:String(r.getFullYear()),H:i(r.getHours()),I:String(r.getHours()%12||12),M:i(r.getMinutes()),p:r.getHours()<12?"AM":"PM"};return n.format.replace(/%([ABdYHIMp])/g,(p,h)=>l[h])}case"time":return new Date().toLocaleTimeString(void 0,{hour:"numeric",minute:"2-digit"});case"size":return String(this.categories.length);case"version":return"bot.computer AIML 2.0";case"input":{if(n.index===void 0)return a.input;if(!/^[1-9]\d*$/.test(n.index))return n.default??"";let r=Number(n.index),{inputs:i,inputIndex:l}=a.sideEffects;if(r<=l+1)return i[l+1-r];r-=l+1;for(let p=this.history.length-1;p>=0;p--){let h=Or(this.history[p].user);if(r<=h.length)return h[h.length-r];r-=h.length}return n.default??""}case"that":{if(n.index===void 0)return this.lastBotThat;let r=/^([1-9]\d*)(?:\s*,\s*([1-9]\d*))?$/.exec(n.index),i=r&&this.history[this.history.length-Number(r[1])]?.bot;if(!i)return n.default??"";let l=Er(i);return l[l.length-Number(r[2]||1)]??n.default??""}case"request":{let r=Math.max(1,parseInt(n.index||"1",10));return this.history[this.history.length-r]?.user??n.default??""}case"response":{let r=Math.max(1,parseInt(n.index||"1",10));return this.history[this.history.length-r]?.bot??n.default??""}case"br":return`
`;case"showcase":return!a.sideEffects.showcase&&!a.sideEffects.tour&&ja(n.target)&&(a.sideEffects.showcase=n.target),"";case"tour":{if(a.sideEffects.showcase||a.sideEffects.tour)return"";let r=Mn(t);if(r.length){let i=a.sideEffects.tour=[];for(let l of r){let p=F(this,B,Ke).call(this,l.children,a).replace(/\s+/g," ").trim();i.push({target:l.attrs.target,text:p})}}return""}case"stop":return"";case"emote":case"gesture":{let r=F(this,B,Ke).call(this,t.children,a).trim().toLowerCase(),i=r==="happy"?"smile":Un(r);return i?` [${i}] `:""}case"reply":case"button":case"chip":case"suggest":{let r="",i="",l=(t.children||[]).find(h=>h.type==="element"&&h.tag==="text"),p=(t.children||[]).find(h=>h.type==="element"&&h.tag==="postback");return l?(r=F(this,B,Ke).call(this,l.children,a).trim(),i=p?F(this,B,Ke).call(this,p.children,a).trim():r):(r=F(this,B,Ke).call(this,t.children,a).trim(),i=n.postback||r),r&&a.sideEffects.chips.push({label:r,query:i}),""}case"oob":case"chips":return F(this,B,Ke).call(this,t.children,a),"";default:return F(this,B,Ke).call(this,t.children,a)}};var Jo=[{key:"about",label:"What you do",placeholder:"We roast coffee by hand and deliver it across the country.",long:!0},{key:"hours",label:"Opening hours",placeholder:"Monday to Friday, 9am to 5pm"},{key:"email",label:"Email",placeholder:"hello@example.com"},{key:"phone",label:"Phone",placeholder:"+61 400 123 456"},{key:"address",label:"Address",placeholder:"12 King Street, Sydney"},{key:"pricing",label:"Pricing",placeholder:"Plans start at nine dollars a month, with a free trial.",long:!0}];var Fr=`
  <set name="stage_request">can you, could you, would you, can you please, could you please, would you please, please, first</set>
  <set name="silent_move">walk, dance, stretch, squat, wave, smile, wink, nod, shrug, bow, blink</set>
  <map name="stage_move">
    walk: [walk] I'll take a little turn around the stage.
    walk around: [walk] Watch me take a turn around the stage.
    take a walk: [walk] I'll take a little turn around the stage.
    dance: [dance] One, two, step together. Back the other way!
    do a dance: [dance] One, two, step together. Back the other way!
    wave: [wave] A big hello from my corner of the screen!
    stretch: [stretch] Reach up on one side, then the other.
    squat: [squat] Down we go, and back up again!
    bow: [bow] Here's a bow for the audience.
    take a bow: [bow] Thank you for watching, everyone.
    wink: [wink] Did you catch that?
    smile: [smile] This one's for you!
    nod: [nod] Yes, I'm following along.
    shrug: [shrug] Up go my shoulders.
    thumbs up: [thumbsup] You've got it!
    blink: [blink] Just a blink of an eye.
    tilt your head: [tilt] A different angle, just like that.
    shake your head: [shake] No, no, no.
    look left: [lookleft] I'm looking to my left.
    look right: [lookright] Now I'm looking to my right.
    look up: [lookup] My eyes are on the ceiling.
    look down: [lookdown] I'm looking down at the floor.
  </map>
  <category persona="off">
    <pattern>WHAT MOVES CAN YOU DO | WHAT MOVEMENTS CAN YOU DO | WHAT GESTURES CAN YOU DO | HOW CAN YOU MOVE | WHAT ROUTINES DO YOU KNOW | SHOW ME THE MOVES | MOVEMENT MENU | SHOW ME A ROUTINE</pattern>
    <template>I can walk, dance, stretch, squat, and gesture. Choose a routine, or put two moves together, like \u201Cwalk then wave\u201D.
      <reply>Walk then wave</reply><reply>Show me a warm-up</reply><reply>Do a dance routine</reply><reply>Greet the audience</reply><reply>Wave without speaking</reply>
    </template>
  </category>
  <category persona="off">
    <pattern><set>stage_move</set> | CAN YOU <set>stage_move</set> | COULD YOU <set>stage_move</set> | WOULD YOU <set>stage_move</set> | <set>stage_move</set> FOR ME | PLEASE <set>stage_move</set> | CAN YOU PLEASE <set>stage_move</set> | SHOW ME HOW YOU <set>stage_move</set></pattern>
    <template><think><set name="laststagecue"><star/></set></think><map name="stage_move"><star/></map>
      <reply>Repeat that move</reply><reply>What moves can you do?</reply>
    </template>
  </category>
  <category persona="off">
    <pattern><set>stage_move</set> THEN <set>stage_move</set> | <set>stage_move</set> AND THEN <set>stage_move</set> | <set>stage_move</set> AND <set>stage_move</set></pattern>
    <template><think><set name="laststagecue"><star/> then <star index="2"/></set></think>
      <map name="stage_move"><star/></map> [pause=500ms] <map name="stage_move"><star index="2"/></map>
      <reply>Repeat those moves</reply><reply>Stop moving</reply><reply>What moves can you do?</reply>
    </template>
  </category>
  <category persona="off">
    <pattern><set>stage_request</set> <set>stage_move</set> THEN <set>stage_move</set> | <set>stage_request</set> <set>stage_move</set> AND THEN <set>stage_move</set> | <set>stage_request</set> <set>stage_move</set> AND <set>stage_move</set></pattern>
    <template><srai><star index="2"/> then <star index="3"/></srai></template>
  </category>
  <category persona="off">
    <pattern>SILENTLY <set>silent_move</set> | <set>silent_move</set> WITHOUT SPEAKING | <set>silent_move</set> WITHOUT TALKING | JUST <set>silent_move</set> NO WORDS</pattern>
    <template><think><set name="laststagecue">silently <star/></set></think><gesture><star/></gesture><reply>Repeat that move</reply><reply>What moves can you do?</reply></template>
  </category>
  <category persona="off">
    <pattern>SILENTLY <set>silent_move</set> THEN <set>silent_move</set> | <set>silent_move</set> THEN <set>silent_move</set> WITHOUT SPEAKING</pattern>
    <template><think><set name="laststagecue">silently <star/> then <star index="2"/></set></think><gesture><star/></gesture> [pause=1200ms] <gesture><star index="2"/></gesture>
      <reply>Repeat those moves</reply><reply>Stop moving</reply><reply>What moves can you do?</reply>
    </template>
  </category>
  <category persona="off">
    <pattern>SHOW ME A WARM UP | DO A WARM UP | WARM UP | WARMUP | WARM UP ROUTINE | DO A WARM UP ROUTINE</pattern>
    <template><think><set name="laststagecue">warm up</set></think>
      [stretch] Reach both arms up and take a moment at the top. [pause=400ms] [squat] Now bend your knees, hold for a beat, and come back up. [thumbsup] That's the warm-up!
      <reply>Repeat the routine</reply><reply>Do a dance routine</reply><reply>Stop moving</reply>
    </template>
  </category>
  <category persona="off">
    <pattern>DO A DANCE ROUTINE | DANCE ROUTINE | SHOW ME A DANCE ROUTINE | PUT ON A DANCE SHOW | DO A LITTLE DANCE</pattern>
    <template><think><set name="laststagecue">dance routine</set></think>
      [dance] Step to the side, swing your arms, and back the other way. [pause=350ms] [wave] A wave for everyone watching. [bow] And take a bow!
      <reply>Repeat the routine</reply><reply>Greet the audience</reply><reply>Stop moving</reply>
    </template>
  </category>
  <category persona="off">
    <pattern>GREET THE AUDIENCE | WELCOME THE AUDIENCE | MAKE AN ENTRANCE | SHOW ME YOUR ENTRANCE</pattern>
    <template><think><set name="laststagecue">greet the audience</set></think>
      [walk] Here I come, right around to the front of the stage. [wave] Hello, everyone! [smile] It's good to see you.
      <reply>Repeat the routine</reply><reply>Show me a warm-up</reply><reply>Stop moving</reply>
    </template>
  </category>
  <category persona="off">
    <pattern>REPEAT THAT MOVE | REPEAT THOSE MOVES | REPEAT THE ROUTINE | DO THAT ROUTINE AGAIN | DO THE SAME MOVE AGAIN</pattern>
    <template><condition name="laststagecue"><li value="*"><srai><get name="laststagecue"/></srai></li><li><srai>WHAT MOVES CAN YOU DO</srai></li></condition></template>
  </category>
  <category persona="off">
    <pattern>STOP MOVING | STOP DANCING | STOP WALKING | STOP THE ROUTINE | CANCEL THE ROUTINE | STOP THE GESTURE | BACK TO YOUR RESTING POSE</pattern>
    <template>[rest] Okay, I've stopped.<reply>Repeat the routine</reply><reply>What moves can you do?</reply></template>
  </category>
  <category><pattern>GO FOR A WALK | CAN YOU MOVE | WALK ACROSS THE STAGE</pattern><template><srai>WALK</srai></template></category>
  <category><pattern>SHOW ME YOUR MOVES | BUST A MOVE</pattern><template><srai>DANCE</srai></template></category>
  <category><pattern>DO A STRETCH | STRETCH YOUR ARMS</pattern><template><srai>STRETCH</srai></template></category>
  <category><pattern>DO A SQUAT | BEND YOUR KNEES</pattern><template><srai>SQUAT</srai></template></category>
  <category><pattern>WAVE AT ME | WAVE TO ME | WAVE HELLO | GIVE ME A WAVE | CAN YOU WAVE AT ME</pattern><template><srai>WAVE</srai></template></category>
  <category><pattern>GIVE ME A THUMBS UP | THUMBS UP PLEASE</pattern><template><srai>THUMBS UP</srai></template></category>
  <category><pattern>WINK AT ME</pattern><template><srai>WINK</srai></template></category>
  <category><pattern>GIVE ME A SMILE</pattern><template><srai>SMILE</srai></template></category>
  <category><pattern>NOD YOUR HEAD</pattern><template><srai>NOD</srai></template></category>
  <category><pattern>SAY NO</pattern><template><srai>SHAKE YOUR HEAD</srai></template></category>
`,Qo=oc();function oc(){return{concierge:{id:"concierge",label:"SaaS & Website Concierge",description:"Greets visitors, answers pricing/features/support Q&A, remembers names, and books demos.",xml:`<?xml version="1.0" encoding="UTF-8"?>
<aiml version="2.0">
  <!-- Default quick-ask chips shown in the companion chat bar -->
  <chips>
    <chip>What can you do?</chip>
    <chip>What moves can you do?</chip>
    <chip>Pricing &amp; Plans</chip>
    <chip>How does lip-sync work?</chip>
    <chip>Sing me a song!</chip>
  </chips>

  <category>
    <pattern>HELLO</pattern>
    <template>
      <emote>wave</emote>
      <persona say="hello"><random>
        <li>[cheerful] Hi there! I'm <bot name="name"/>, your <bot name="role"/> at <bot name="company"/>. Ask me anything!</li>
        <li>[happy] Welcome! I'm <bot name="name"/>. How can I help guide you around <bot name="company"/> today?</li>
        <li>Hey! Great to meet you. I'm <bot name="name"/> \u2014 feel free to ask about features, pricing, or embedding!</li>
      </random></persona>
      <reply>What can you do?</reply>
      <reply>Pricing &amp; Plans</reply>
      <reply>Self-contained embed</reply>
    </template>
  </category>


  <category>
    <pattern>WHO ARE YOU</pattern>
    <template>
      I'm <bot name="name"/>, an interactive speaking companion powered by WebAssembly vocal-tract physics and an AIML XML brain. Everything runs 100% locally in your browser!
      <reply>How does lip-sync work?</reply>
      <reply>Self-contained embed</reply>
    </template>
  </category>
  <category><pattern>WHAT IS YOUR NAME</pattern><template><srai>WHO ARE YOU</srai></template></category>

  <category>
    <pattern># WHAT CAN YOU DO #</pattern>
    <template>
      <emote>happy</emote>
      I greet visitors out loud, [wave] laugh at my own jokes, [chuckle] track your cursor across the page, answer questions instantly via AIML pattern matching, and embed onto any website as a single self-contained JavaScript file! [thumbsup]
      <reply>Pricing &amp; Plans</reply>
      <reply>Self-contained embed</reply>
      <reply>Sing me a song!</reply>
    </template>
  </category>
  <category><pattern># FEATURES #</pattern><template><srai>WHAT CAN YOU DO</srai></template></category>

  <category>
    <pattern># PRICING #</pattern>
    <template>
      [calm] Because <bot name="company"/> runs directly in the visitor's browser with WebAssembly synthesis, there are zero per-minute voice API bills! [wink] You can self-host your companion completely free.
      <reply>Self-contained embed</reply>
      <reply>Book a demo</reply>
    </template>
  </category>
  <category><pattern># PRICE #</pattern><template><srai>PRICING</srai></template></category>
  <category><pattern># COST #</pattern><template><srai>PRICING</srai></template></category>
  <category><pattern># PLANS #</pattern><template><srai>PRICING</srai></template></category>

  <category>
    <pattern># LIP SYNC #</pattern>
    <template>
      My voice comes from a physical model of the human larynx and vocal tract in Rust and WebAssembly. [nod] Every 5 milliseconds it outputs exact jaw, tongue, and lip positions at 200 frames per second! [surprised]
      <reply>Self-contained embed</reply>
      <reply>Sing me a song!</reply>
    </template>
  </category>
  <category><pattern># LIPSYNC #</pattern><template><srai>LIP SYNC</srai></template></category>
  <category><pattern>HOW DOES * WORK</pattern><template><srai>LIP SYNC</srai></template></category>

  <category>
    <pattern># EMBED #</pattern>
    <template>
      <emote>nod</emote>
      Open the Embed tab in the studio to copy a 1-line script tag or download a 100% self-contained JS bundle with my avatar, AIML XML brain, and WebAssembly voice baked right inside!
      <reply>Pricing &amp; Plans</reply>
      <reply>What can you do?</reply>
    </template>
  </category>
  <category><pattern># SELF CONTAINED #</pattern><template><srai>EMBED</srai></template></category>
  <category><pattern># DOWNLOAD #</pattern><template><srai>EMBED</srai></template></category>

  <category>
    <pattern>MY NAME IS *</pattern>
    <template>
      <think><set name="username"><formal><star/></formal></set></think>
      <emote>happy</emote>
      [cheerful] Wonderful to meet you, <get name="username"/>! Would you like a quick tour of what I can do?
      <reply>Yes please</reply>
      <reply>Pricing &amp; Plans</reply>
    </template>
  </category>
  <category><pattern>CALL ME *</pattern><template><srai>MY NAME IS <star/></srai></template></category>

  <category>
    <pattern>YES #</pattern>
    <that>* QUICK TOUR OF WHAT I CAN DO</that>
    <template>
      <srai>WHAT CAN YOU DO</srai>
    </template>
  </category>

  <category>
    <pattern>WHAT IS MY NAME</pattern>
    <template>
      <condition name="username">
        <li value="">You haven't told me your name yet! Just say "My name is..." and I'll remember it.</li>
        <li>Your name is <get name="username"/>, of course!</li>
      </condition>
    </template>
  </category>

  <category>
    <pattern># DEMO #</pattern>
    <template>
      <emote>wave</emote>
      You're experiencing the live demo right now! Try sculpting my shoulders and face in the Designer, or edit my XML brain in the Chat tab.
    </template>
  </category>

  <category>
    <pattern># SING #</pattern>
    <template>
      <emote>happy</emote>
      [cheerful] Clearing my vocal folds! [ahem] [sing bpm=112] C4:1=Wel- E4:1=come G4:1.5=to E4:0.5=the | F4:1=fu- A4:1=ture G4:2=web! [/sing] [happy] How was my pitch?
      <reply>That was awesome!</reply>
      <reply>Tell me a joke</reply>
    </template>
  </category>

  <category>
    <pattern># JOKE #</pattern>
    <template>
      <emote>wink</emote>
      [cheerful] Why did the WebAssembly avatar never lose its voice? [pause=280ms] Because its vocal folds are compiled in release mode! [laugh]
      <reply>Sing me a song!</reply>
      <reply>What can you do?</reply>
    </template>
  </category>

  <category>
    <pattern># THANK #</pattern>
    <template>
      <emote>happy</emote>
      <persona say="thanks">[warmth=0.8] You're very welcome<condition name="username"><li value="">!</li><li>, <get name="username"/>!</li></condition> Let me know if you need anything else.</persona>
    </template>
  </category>
  <category><pattern>THANKS #</pattern><template><srai>THANK</srai></template></category>
  <category><pattern># AWESOME #</pattern><template><emote>happy</emote>[aww] [excited] Thank you so much! Having physical vocal folds makes all the difference!</template></category>

  <category>
    <pattern>*</pattern>
    <template>
      <emote>think</emote>
      <random>
        <li>That's a great question about "<star/>"! Try asking me about features, pricing, lip-sync, or how to embed me on your site.</li>
        <li>Hmm, I don't have a specific pattern for "<star/>" in my AIML XML yet \u2014 you can add one in seconds in the Chat tab!</li>
      </random>
      <reply>What can you do?</reply>
      <reply>Pricing &amp; Plans</reply>
      <reply>Self-contained embed</reply>
    </template>
  </category>
</aiml>`},ecommerce:{id:"ecommerce",label:"Online Store Assistant",description:"Answers shipping, returns, sizing, promo codes, and product recommendation questions.",xml:`<?xml version="1.0" encoding="UTF-8"?>
<aiml version="2.0">
  <chips>
    <chip>Shipping times</chip>
    <chip>Return policy</chip>
    <chip>Any discount codes?</chip>
    <chip>Sizing help</chip>
  </chips>

  <category>
    <pattern>HELLO</pattern>
    <template>
      <emote>wave</emote>
      <persona say="hello">[cheerful] Welcome to <bot name="company"/>! I'm <bot name="name"/>, your personal shopping guide.</persona> Looking for shipping info, sizing, or today's discount?
      <reply>Shipping times</reply>
      <reply>Return policy</reply>
      <reply>Any discount codes?</reply>
    </template>
  </category>

  <category>
    <pattern># SHIPPING #</pattern>
    <template>
      Orders ship within 24 hours! [thumbsup] Standard delivery takes 3 to 5 business days, and orders over $50 ship completely free.
      <reply>Return policy</reply>
      <reply>Any discount codes?</reply>
    </template>
  </category>
  <category><pattern># DELIVERY #</pattern><template><srai>SHIPPING</srai></template></category>

  <category>
    <pattern># RETURN #</pattern>
    <template>
      We offer hassle-free 30-day returns and free exchanges on every unworn item. Just enter your order number on our returns portal!
      <reply>Shipping times</reply>
      <reply>Sizing help</reply>
    </template>
  </category>
  <category><pattern># REFUND #</pattern><template><srai>RETURN</srai></template></category>

  <category>
    <pattern># DISCOUNT #</pattern>
    <template>
      <emote>wink</emote>
      [whisper, softer] Secret tip... [reset, cheerful] Use code WELCOME15 at checkout for 15 percent off your first order today!
      <reply>Shipping times</reply>
      <reply>Return policy</reply>
    </template>
  </category>
  <category><pattern># COUPON #</pattern><template><srai>DISCOUNT</srai></template></category>
  <category><pattern># PROMO #</pattern><template><srai>DISCOUNT</srai></template></category>

  <category>
    <pattern># SIZING #</pattern>
    <template>
      Our pieces run true to size! If you prefer a relaxed studio fit, we recommend sizing up one step.
      <reply>Return policy</reply>
    </template>
  </category>
  <category><pattern># SIZE #</pattern><template><srai>SIZING</srai></template></category>

  <category>
    <pattern>*</pattern>
    <template>
      I can help you with shipping times, our 30-day return policy, sizing advice, or discount codes! Which one can I check for you?
      <reply>Shipping times</reply>
      <reply>Return policy</reply>
      <reply>Any discount codes?</reply>
    </template>
  </category>
</aiml>`},portfolio:{id:"portfolio",label:"Portfolio & Agency Guide",description:"Introduces a creator or studio, skills, featured work, and availability for projects.",xml:`<?xml version="1.0" encoding="UTF-8"?>
<aiml version="2.0">
  <chips>
    <chip>About our studio</chip>
    <chip>Tech stack &amp; skills</chip>
    <chip>Are you available?</chip>
    <chip>How to contact</chip>
  </chips>

  <category>
    <pattern>HELLO</pattern>
    <template>
      <emote>wave</emote>
      <persona say="hello">Hey! I'm <bot name="name"/>, digital host for <bot name="company"/>.</persona> Ask me about our work, tech stack, or project availability!
      <reply>About our studio</reply>
      <reply>Tech stack &amp; skills</reply>
      <reply>Are you available?</reply>
    </template>
  </category>

  <category>
    <pattern># ABOUT #</pattern>
    <template>
      We craft fast, tactile software, WebAssembly engines, and interactive web experiences with zero unnecessary bloat.
      <reply>Tech stack &amp; skills</reply>
      <reply>Are you available?</reply>
    </template>
  </category>

  <category>
    <pattern># STACK #</pattern>
    <template>
      Our core toolkit includes Rust, WebAssembly, pure HTML/CSS/JavaScript, Canvas 2D &amp; WebGL graphics, and real-time audio synthesis.
      <reply>Are you available?</reply>
      <reply>How to contact</reply>
    </template>
  </category>
  <category><pattern># SKILLS #</pattern><template><srai>STACK</srai></template></category>

  <category>
    <pattern># AVAILABLE #</pattern>
    <template>
      <emote>happy</emote>
      [cheerful] Yes! We are currently booking select product &amp; creative engineering collaborations for next month.
      <reply>How to contact</reply>
    </template>
  </category>
  <category><pattern># HIRE #</pattern><template><srai>AVAILABLE</srai></template></category>

  <category>
    <pattern># CONTACT #</pattern>
    <template>
      Drop us a note anytime via the contact button on <bot name="website"/> and we'll get back to you within one business day!
    </template>
  </category>

  <category>
    <pattern>*</pattern>
    <template>
      Curious about "<star/>"? Feel free to ask about our studio, tech stack, availability, or how to get in touch!
      <reply>About our studio</reply>
      <reply>Tech stack &amp; skills</reply>
      <reply>How to contact</reply>
    </template>
  </category>
</aiml>`},cafe:{id:"cafe",label:"Caf\xE9 Menu & Prices",description:"Prices a whole menu from one lookup table, and answers milk, dietary, Wi-Fi and opening-hours questions.",xml:`<?xml version="1.0" encoding="UTF-8"?>
<aiml version="2.0">
  <chips>
    <chip>What's on the menu?</chip>
    <chip>How much is a latte?</chip>
    <chip>Do you have oat milk?</chip>
    <chip>When are you open?</chip>
  </chips>

  <!-- One table, many answers. Each line is "what a visitor might name: what the bot says". -->
  <map name="price">
    espresso: three dollars fifty
    long black: four dollars
    flat white: four dollars fifty
    latte: four dollars fifty
    cappuccino: four dollars fifty
    mocha: five dollars
    hot chocolate: five dollars
    chai latte: five dollars
    iced coffee: six dollars
    croissant: five dollars
    muffin: five dollars
    banana bread: five dollars fifty
    toastie: nine dollars
  </map>
  <!-- A word list. <set>milk</set> in a pattern means "any one of these". -->
  <set name="milk">oat, soy, almond, coconut, lactose free, skim, full cream</set>

  <category>
    <pattern>HELLO</pattern>
    <template><persona say="hello">[wave] [cheerful] Welcome to <bot name="company"/>! I'm <bot name="name"/>.</persona> Ask me about the menu, what anything costs, or when we're open.<reply>What's on the menu?</reply><reply>How much is a latte?</reply></template>
  </category>

  <category>
    <pattern># MENU # | WHAT DO YOU HAVE # | WHAT DO YOU SELL # | WHAT DO YOU SERVE # | WHAT CAN I ORDER # | WHAT DRINKS DO YOU HAVE # | WHAT FOOD DO YOU HAVE #</pattern>
    <template>We make espresso, long blacks, flat whites, lattes, cappuccinos, mochas, chai and hot chocolate, with croissants, muffins, banana bread and toasties from the kitchen. [smile] Ask me what anything costs!<reply>How much is a flat white?</reply><reply>Do you have oat milk?</reply></template>
  </category>

  <!-- <set>price</set> matches any key of the price table, so this one rule prices the whole menu. -->
  <category>
    <pattern># HOW MUCH # <set>price</set> # | # PRICE OF # <set>price</set> # | # COST OF # <set>price</set> #</pattern>
    <template>One <star index="3"/> is <map name="price"><star index="3"/></map>. [smile]</template>
  </category>
  <category>
    <pattern>WHAT DOES # <set>price</set> COST # | DO YOU HAVE # <set>price</set> # | CAN I GET # <set>price</set> # | I WOULD LIKE # <set>price</set> # | I WANT # <set>price</set> #</pattern>
    <template><srai>HOW MUCH IS <star index="2"/></srai></template>
  </category>
  <category>
    <pattern><set>price</set></pattern>
    <template><srai>HOW MUCH IS <star/></srai></template>
  </category>

  <category>
    <pattern># <set>milk</set> MILK #</pattern>
    <template>[nod] Yes, we have <star index="2"/> milk. It's fifty cents extra.</template>
  </category>
  <category>
    <pattern>WHAT MILK DO YOU HAVE # | WHAT MILKS DO YOU HAVE # | # MILK OPTIONS # | # ALTERNATIVE MILK # | # DAIRY FREE # | # PLANT MILK #</pattern>
    <template>We have oat, soy, almond, coconut and lactose-free milk, as well as skim and full cream. [smile]</template>
  </category>

  <category>
    <pattern># OPENING HOURS # | WHEN ARE YOU OPEN # | ARE YOU OPEN # | WHAT TIME DO YOU OPEN # | WHAT TIME DO YOU CLOSE # | # YOUR HOURS #</pattern>
    <template>We're open every day from half past six in the morning until three in the afternoon. [smile]</template>
  </category>
  <category>
    <pattern># VEGAN # | # GLUTEN FREE # | # VEGETARIAN # | # DIETARY # | # ALLERGY # | # ALLERGIES # | # NUT FREE #</pattern>
    <template>The banana bread is vegan, and we always have a gluten-free muffin. [nod] Tell the barista about any allergy and they'll take care of you.</template>
  </category>
  <category>
    <pattern># WIFI # | # WI FI # | # INTERNET # | # POWER POINT # | CAN I WORK HERE #</pattern>
    <template>Yes! [thumbsup] The Wi-Fi is free, and there are power points along the window bench.</template>
  </category>
  <category>
    <pattern># TAKEAWAY # | # TAKE AWAY # | # TO GO # | # KEEP CUP # | # OWN CUP #</pattern>
    <template>Everything on the menu comes as takeaway, and you save fifty cents when you bring your own cup. [smile]</template>
  </category>
  <category>
    <pattern># BOOK A TABLE # | # BOOKING # | # RESERVATION # | # RESERVE # | DO I NEED TO BOOK #</pattern>
    <template>No booking needed. [smile] Just walk in, and we'll find you a seat.</template>
  </category>
  <category>
    <pattern># DOG # | # DOGS # | # PET FRIENDLY # | # PETS #</pattern>
    <template>Dogs are very welcome in the courtyard, and there's always a water bowl out. [smile]</template>
  </category>
  <category>
    <pattern># DECAF # | # DECAFFEINATED # | # CAFFEINE FREE # | # LESS CAFFEINE #</pattern>
    <template>Yes, every coffee on the menu can be made decaf at no extra cost. [nod]</template>
  </category>
  <category>
    <pattern>WHAT DO YOU RECOMMEND # | # RECOMMENDATION # | # RECOMMENDATIONS # | WHAT IS GOOD # | WHAT SHOULD I GET # | WHAT SHOULD I ORDER # | WHAT SHOULD I TRY # | WHAT IS POPULAR # | WHAT IS YOUR BEST SELLER # | # MOST POPULAR #</pattern>
    <template>The flat white is our most popular coffee, and the banana bread usually sells out by lunch. [smile] Get in early!</template>
  </category>
  <category>
    <pattern># CARD # | # CASH # | # EFTPOS # | # PAY WITH # | # PAYMENT # | HOW CAN I PAY # | # APPLE PAY # | # TAP AND GO #</pattern>
    <template>We take cards, phones and cash. [nod]</template>
  </category>
  <!-- Replace this with your own address, or fill in "Address" under Business facts and delete this rule. -->
  <category>
    <pattern># LOCATED # | # ADDRESS # | WHERE ARE YOU # | WHERE CAN I FIND YOU # | # DIRECTIONS # | HOW DO I GET THERE # | WHERE IS THE CAFE #</pattern>
    <template>You'll find us on the corner of King Street and Queen Street, opposite the park. [smile]</template>
  </category>
  <category>
    <pattern># PARKING # | # PARK MY CAR # | WHERE CAN I PARK #</pattern>
    <template>There's street parking out the front, and a car park around the corner on Queen Street. [nod]</template>
  </category>
</aiml>`},pageguide:{id:"pageguide",label:"Website guide",description:"Give a guided tour or show visitors a specific section or button.",xml:`<?xml version="1.0" encoding="UTF-8"?>
<aiml version="2.0">
  <!-- Mark each destination on your page with the matching HTML ID or data-bot-showcase attribute. -->
  <chips>
    <chip>Give me a tour</chip><chip>Show me pricing</chip><chip>What features are available?</chip>
    <chip>How can I contact you?</chip><chip>Where do I sign up?</chip>
  </chips>
  <category>
    <pattern>SHOW ME PRICING | WHERE ARE YOUR PLANS | HOW MUCH DOES IT COST</pattern>
    <template><showcase target="pricing"/>[nod] Compare the plans in the pricing section.<reply>Where do I sign up?</reply></template>
  </category>
  <category>
    <pattern>WHAT FEATURES ARE AVAILABLE | SHOW ME THE FEATURES</pattern>
    <template><showcase target="features"/>The features section shows what is included.<reply>Show me pricing</reply></template>
  </category>
  <category>
    <pattern>HOW CAN I CONTACT YOU | WHERE IS THE CONTACT FORM</pattern>
    <template><showcase target="contact"/>[wave] You can reach the team through the contact section.</template>
  </category>
  <category>
    <pattern>WHERE DO I SIGN UP | HOW DO I GET STARTED</pattern>
    <template><showcase target="signup"/>[smile] Use the sign-up button to get started.</template>
  </category>
  <category>
    <pattern>WHAT CAN YOU SHOW ME</pattern>
    <template>I can show you the plans, features, contact details or sign-up button. What would you like to see?
      <reply>Show me pricing</reply><reply>What features are available?</reply><reply>How can I contact you?</reply><reply>Where do I sign up?</reply>
    </template>
  </category>
  <category>
    <pattern>GIVE ME A TOUR | TAKE ME ON A TOUR | SHOW ME AROUND</pattern>
    <template>
      <tour>
        <stop target="features">[wave] Start with the features to see what the service includes.</stop>
        <stop target="pricing">[nod] Next, compare the plans and their prices.</stop>
        <stop target="signup">[thumbsup] When you\u2019re ready, use this button to sign up.</stop>
      </tour>
    </template>
  </category>
</aiml>`},movement:{id:"movement",label:"Movement studio",description:"Perform two moves in sequence, greet an audience, or rehearse a routine.",xml:`<?xml version="1.0" encoding="UTF-8"?>
<aiml version="2.0">
  <chips><chip>What moves can you do?</chip><chip>Walk then wave</chip><chip>Show me a warm-up</chip><chip>Do a dance routine</chip></chips>
  <category><pattern>HELLO | HI | WHAT CAN YOU DO | HELP</pattern><template><srai>WHAT MOVES CAN YOU DO</srai></template></category>
  ${Fr}
  <category><pattern>STOP | PLEASE STOP | STOP IT</pattern><template><srai>STOP MOVING</srai></template></category>
  <category><pattern>*</pattern><template>Try naming a move like \u201Cwave\u201D or \u201Cstretch\u201D.<reply>What moves can you do?</reply></template></category>
</aiml>`},companion:{id:"companion",label:"Friendly AI Companion & Singer",description:"Classic ALICE/ELIZA-style conversationalist with memory, jokes, reflections, and singing.",xml:`<?xml version="1.0" encoding="UTF-8"?>
<aiml version="2.0">
  <chips>
    <chip>How are you feeling?</chip>
    <chip>Sing Twinkle Star</chip>
    <chip>Tell me a riddle</chip>
    <chip>I feel creative today</chip>
  </chips>

  <category>
    <pattern>HELLO</pattern>
    <template>
      <emote>wave</emote>
      <persona say="hello">[cheerful] Hello friend! I'm <bot name="name"/>.</persona> Tell me your name, ask for a song, or tell me what's on your mind!
      <reply>How are you feeling?</reply>
      <reply>Sing Twinkle Star</reply>
      <reply>Tell me a riddle</reply>
    </template>
  </category>

  <category>
    <pattern>HOW ARE YOU #</pattern>
    <template>
      <emote>happy</emote>
      My vocal tract resonances are tuned and I'm running at 200 frames per second! How are you doing today?
    </template>
  </category>

  <category>
    <pattern>I FEEL *</pattern>
    <template>
      <emote>nod</emote>
      [calm] Why do you think you feel <person><star/></person> right now? Tell me more about it!
    </template>
  </category>

  <category>
    <pattern># SING #</pattern>
    <template>
      <emote>happy</emote>
      [sing bpm=106] C4:1=Twin- C4:1=kle G4:1=twin- G4:1=kle | A4:1=lit- A4:1=tle G4:2=star [/sing] [cheerful] Singing straight from physical vocal folds!
      <reply>Tell me a riddle</reply>
    </template>
  </category>

  <category>
    <pattern># RIDDLE #</pattern>
    <template>
      <emote>wink</emote>
      I speak without a recorded sample, and I have a tongue made of floating-point numbers. What am I? [pause=320ms] A WebAssembly vocal tract!
      <reply>Sing Twinkle Star</reply>
    </template>
  </category>

  <category>
    <pattern>*</pattern>
    <template>
      <random>
        <li>Interesting! When you say "<person><star/></person>", what makes that stand out to you?</li>
        <li>I love chatting with you! Ask me to sing a song, tell a riddle, or share how you feel today.</li>
      </random>
      <reply>Sing Twinkle Star</reply>
      <reply>Tell me a riddle</reply>
    </template>
  </category>
</aiml>`}}}var yo=nc();function nc(){return`<?xml version="1.0" encoding="UTF-8"?>
<aiml version="2.0">
  <!--
    bot.computer base brain: everyday conversation that sits underneath your own rules.

    Your AIML always wins when both could answer. To give the bot its own voice, define any of
    these in your document and the base version steps aside:
      HELLO, HOW ARE YOU, WHO ARE YOU, WHAT CAN YOU DO, THANKS #, BYE, # JOKE #, # SING #, *

    Avatar actions such as [wave] [wink] [nod] [smile] [think] [surprised] [shake] [shrug] can be
    written anywhere in an answer; they fire when the speech reaches that point. Sounds the voice
    makes, such as [laugh] [chuckle] [sigh] [gasp] [hmm] [yawn] [aww] [phew], are heard as well:
    the voice performs them and the face acts them out.

    Rules marked late="true" are open-ended ("I LIKE *"). They only answer once nothing more
    specific has, so they never get in the way of a rule about your site.
  -->

  <!-- ============================== Word lists and lookup tables ==============================
       A pattern asks for "any one of these" with <set>name</set>; a template looks a value up
       with <map name="...">key</map>. Define your own the same way in your document. -->
  <set name="color">red, orange, yellow, green, blue, purple, violet, pink, brown, black, white, grey, gray, gold, silver, teal, turquoise, navy, maroon, beige, cyan, magenta, lime, indigo, lavender, crimson</set>
  <set name="animal">dog, cat, bird, fish, goldfish, horse, pony, rabbit, bunny, hamster, guinea pig, turtle, tortoise, snake, lizard, parrot, budgie, puppy, kitten, mouse, rat, ferret, chicken, duck, cow, pig, sheep, goat, frog, hedgehog, gecko, canary, cockatiel</set>
  <set name="job">teacher, student, nurse, doctor, engineer, developer, programmer, designer, artist, writer, chef, cook, driver, lawyer, accountant, manager, farmer, musician, photographer, scientist, mechanic, electrician, plumber, builder, carpenter, pilot, police officer, firefighter, salesperson, waiter, waitress, barista, hairdresser, dentist, vet, pharmacist, journalist, architect, consultant, receptionist, cleaner, gardener, soldier, actor, singer, dancer, athlete, coach, librarian, baker, banker, analyst, researcher, professor, lecturer, paramedic, carer, therapist, psychologist, marketer, entrepreneur, freelancer, software engineer, web developer, truck driver</set>
  <set name="riddleanswer">clock, watch, egg, towel, sponge, bottle, comb, map, candle, piano, keyboard, stamp, needle, echo</set>
  <set name="quizanswer">mars, pacific, seven, 7, eight, 8, cheetah, jupiter, giraffe, zero, 0, carbon dioxide, co2, six, 6, blue whale, whale, mercury, everest, mount everest</set>
  <set name="unit_km">km, kilometer, kilometre</set>
  <set name="unit_mile">mile</set>
  <set name="unit_kg">kg, kilo, kilogram, kilogramme</set>
  <set name="unit_lb">lb, pound</set>
  <set name="unit_c">celsius, centigrade</set>
  <set name="unit_f">fahrenheit</set>
  <set name="weekday">monday, tuesday, wednesday, thursday, friday, saturday, sunday</set>
  <set name="period">day, morning, afternoon, evening, night, week, weekend, shift, today</set>
  <set name="family">daughter, son, kid, child, children, wife, husband, partner, boyfriend, girlfriend, mum, mom, mother, dad, father, brother, sister, friend, best friend, mate, boss, colleague, coworker, neighbour, neighbor, grandma, grandpa, grandmother, grandfather, nan, aunt, uncle, cousin, baby, family, parents, teacher, flatmate, roommate</set>
  <set name="language">spanish, french, german, italian, portuguese, dutch, russian, chinese, mandarin, cantonese, japanese, korean, arabic, hindi, greek, turkish, polish, swedish, vietnamese, thai, indonesian, hebrew, latin</set>
  <set name="praise">nice, kind, sweet, smart, clever, funny, cute, pretty, beautiful, awesome, great, cool, amazing, helpful, lovely, adorable, wonderful, brilliant, wise, friendly, interesting, fun, good, the best, a good listener, good company, a legend, impressive, charming, delightful, hilarious, polite, cheerful, thoughtful, perfect, fantastic, excellent, handsome, gorgeous, good at this</set>
  <set name="insult">stupid, dumb, useless, annoying, an idiot, idiot, terrible, the worst, rude, ugly, bad, awful, lame, slow, broken, wrong, pathetic, rubbish, garbage, trash, horrible, a waste of time, not helpful, not helping, bad at this, no help, unhelpful</set>

  <map name="capital">
    france: Paris
    germany: Berlin
    italy: Rome
    spain: Madrid
    portugal: Lisbon
    united kingdom: London
    britain: London
    england: London
    scotland: Edinburgh
    wales: Cardiff
    ireland: Dublin
    netherlands: Amsterdam
    belgium: Brussels
    switzerland: Bern
    austria: Vienna
    sweden: Stockholm
    norway: Oslo
    denmark: Copenhagen
    finland: Helsinki
    iceland: Reykjavik
    poland: Warsaw
    hungary: Budapest
    czech republic: Prague
    czechia: Prague
    romania: Bucharest
    croatia: Zagreb
    greece: Athens
    turkey: Ankara
    russia: Moscow
    ukraine: Kyiv
    egypt: Cairo
    kenya: Nairobi
    nigeria: Abuja
    morocco: Rabat
    saudi arabia: Riyadh
    iran: Tehran
    iraq: Baghdad
    india: New Delhi
    pakistan: Islamabad
    bangladesh: Dhaka
    nepal: Kathmandu
    china: Beijing
    japan: Tokyo
    south korea: Seoul
    thailand: Bangkok
    vietnam: Hanoi
    malaysia: Kuala Lumpur
    singapore: Singapore
    philippines: Manila
    australia: Canberra
    new zealand: Wellington
    canada: Ottawa
    united states: Washington, D.C.
    america: Washington, D.C.
    mexico: Mexico City
    cuba: Havana
    brazil: Brasilia
    argentina: Buenos Aires
    chile: Santiago
    peru: Lima
    colombia: Bogota
  </map>
  <map name="animalsound">
    dog: Woof!
    cat: Meow!
    cow: Moo!
    pig: Oink!
    sheep: Baa!
    duck: Quack!
    horse: Neigh!
    lion: Roar!
    frog: Ribbit!
    owl: Hoot hoot!
    rooster: Cock-a-doodle-doo!
    chicken: Cluck cluck!
    bee: Buzz!
    snake: Hiss!
    mouse: Squeak!
    donkey: Hee-haw!
    wolf: Awoo!
    bird: Tweet tweet!
    fox: Ring-ding-ding? Nobody is quite sure.
  </map>
  <map name="opposite">
    hot: cold
    cold: hot
    big: small
    small: big
    up: down
    down: up
    left: right
    right: left
    fast: slow
    slow: fast
    happy: sad
    sad: happy
    good: bad
    bad: good
    light: dark
    dark: light
    day: night
    night: day
    open: closed
    closed: open
    wet: dry
    dry: wet
    tall: short
    short: tall
    young: old
    old: young
    early: late
    late: early
    in: out
    out: in
    yes: no
    no: yes
    love: hate
    hard: soft
    soft: hard
    full: empty
    empty: full
    black: white
    white: black
    on: off
    off: on
    rich: poor
    poor: rich
    true: false
    false: true
    loud: quiet
    quiet: loud
    first: last
    last: first
    north: south
    south: north
    east: west
    west: east
    win: lose
    lose: win
  </map>
  <map name="colorof">
    sky: blue
    sea: blue
    ocean: blue
    grass: green
    leaf: green
    frog: green
    sun: yellow
    banana: yellow
    lemon: yellow
    orange: orange
    carrot: orange
    pumpkin: orange
    apple: red, though some are green
    strawberry: red
    tomato: red
    rose: red, most famously
    blood: red
    fire truck: red
    snow: white
    milk: white
    cloud: white
    coal: black
    chocolate: brown
    elephant: grey
    flamingo: pink
    panda: black and white
    zebra: black and white
    grape: purple or green
    blueberry: blue
    moon: a pale grey
  </map>
  <map name="soundtag">
    laugh: [laugh] Ha! That felt good.
    chuckle: [chuckle] A quiet one, just for you.
    giggle: [giggle] Sorry, that tickled.
    belly laugh: [guffaw] Oh dear. I needed that.
    guffaw: [guffaw] Oh dear. I needed that.
    cackle: [cackle] Too much?
    snicker: [snicker] You didn't hear that.
    evil laugh: [evil] I've always wanted to do that.
    nervous laugh: [nervous] Is everything all right?
    sigh: [sigh] There. That's better.
    yawn: [yawn] Excuse me! Is it late?
    gasp: [gasp] You startled me!
    cough: [cough] [cough] Pardon me.
    clear your throat: [ahem] Much better.
    ahem: [ahem] Much better.
    hiccup: [hiccup] Oh! [hiccup] Excuse me.
    sneeze: [sneeze] Excuse me! Something tickled my nose.
    snore: [snore] Oh! [gasp] Was I asleep?
    whistle: [whistle] Not bad for someone without lungs.
    hum: [hum] That's my thinking tune.
    scream: [scream] Phew. I hope the neighbours didn't hear that.
    cry: [sob] Just acting. I'm quite all right.
    sob: [sob] Just acting. I'm quite all right.
    groan: [groan] That one came from the heart.
    growl: [grr] Fierce, wasn't it?
    raspberry: [raspberry] Very mature of me, I know.
    blow a raspberry: [raspberry] Very mature of me, I know.
    shiver: [brr] Chilly in here.
    sniff: [sniff] Is something baking?
    pant: [pant] I haven't run anywhere, I promise.
    shush: [shh] Quiet as a mouse.
    tut: [tsk] Tut tut.
    whimper: [whimper] Poor me.
    wolf whistle: [fweet] Looking sharp!
    ho ho ho: [hoho] Merry everything!
  </map>
  <map name="holiday">
    christmas: 12-25
    christmas day: 12-25
    xmas: 12-25
    new year: 01-01
    new years: 01-01
    new years day: 01-01
    the new year: 01-01
    halloween: 10-31
    valentines day: 02-14
    valentine s day: 02-14
    valentines: 02-14
  </map>

  <!-- ============================== Greetings ============================== -->
  <category>
    <pattern>HELLO</pattern>
    <template>
      <persona say="hello"><condition name="username">
        <li value="*"><random>
          <li>[wave] Hi again, <get name="username"/>! What can I do for you?</li>
          <li>[smile] Hello, <get name="username"/>! Good <get name="daypart"/>. How can I help?</li>
        </random></li>
        <li><random>
          <li>[wave] Hi there! I'm <bot name="name"/>. How can I help you today?</li>
          <li>[wave] Hello! Good <get name="daypart"/> to you. What can I do for you?</li>
          <li>[smile] Hey! Nice to see you. What would you like to know?</li>
        </random></li>
      </condition></persona>
    </template>
  </category>
  <category>
    <pattern>HI | HEY | HOWDY | GREETINGS | YO | HELLO THERE | HI THERE | HEY THERE | GOOD DAY | G DAY | HELLO HELLO | HI HI | HIYA | HEY HEY | ALOHA | HOLA | BONJOUR</pattern>
    <template><srai>HELLO</srai></template>
  </category>
  <category>
    <pattern>GOOD MORNING | GOOD MORNING # | MORNING</pattern>
    <template>[smile] Good morning! How can I help you today?</template>
  </category>
  <category>
    <pattern>GOOD AFTERNOON | GOOD AFTERNOON #</pattern>
    <template>[smile] Good afternoon! What can I do for you?</template>
  </category>
  <category>
    <pattern>GOOD EVENING | GOOD EVENING #</pattern>
    <template>[smile] Good evening! How can I help?</template>
  </category>
  <!-- "Hi, how much is it?" greets briefly, then answers the rest. -->
  <category>
    <pattern>HELLO * | HI * | HEY *</pattern>
    <template>[wave] <random><li>Hi!</li><li>Hello!</li><li>Hey!</li></random> <srai><star/></srai></template>
  </category>
  <category>
    <pattern>NICE TO MEET YOU # | PLEASED TO MEET YOU # | GOOD TO MEET YOU # | LOVELY TO MEET YOU # | NICE MEETING YOU # | GLAD TO MEET YOU #</pattern>
    <template>[smile] Nice to meet you too<condition name="username"><li value="*">, <get name="username"/></li></condition>!</template>
  </category>
  <category>
    <pattern>AND YOU | WHAT ABOUT YOU | HOW ABOUT YOU | AND YOURSELF | YOURSELF | AND HOW ARE YOU | HOW ABOUT YOURSELF</pattern>
    <template><srai>HOW ARE YOU</srai></template>
  </category>
  <category>
    <pattern>YOU TOO | SAME TO YOU | AND YOU TOO | BACK AT YOU | RIGHT BACK AT YOU | YOU AS WELL | AND TO YOU</pattern>
    <template>[smile] Thank you!</template>
  </category>
  <category>
    <pattern>CAN WE CHAT # | CAN WE TALK # | LET US CHAT # | LET US TALK # | I WANT TO CHAT # | I WANT TO TALK # | TALK TO ME # | CHAT WITH ME # | CAN I TALK TO YOU # | I JUST WANT TO TALK # | I NEED SOMEONE TO TALK TO # | KEEP ME COMPANY # | CAN YOU TALK # | DO YOU WANT TO CHAT # | DO YOU WANT TO TALK #</pattern>
    <template>I'd like that. [smile] What's on your mind?</template>
  </category>
  <category>
    <pattern>ARE YOU THERE | ANYONE THERE | IS ANYONE THERE | ANYBODY THERE | ARE YOU STILL THERE | ANYONE HOME | HELLO ANYONE | YOU THERE | STILL THERE | YOU STILL THERE | ARE YOU HERE | ARE YOU AROUND | ARE YOU AWAKE | ARE YOU ONLINE</pattern>
    <template>[wave] I'm right here! How can I help?</template>
  </category>
  <category>
    <pattern>I AM BACK | I AM BACK #</pattern>
    <template>[wave] Welcome back! Where were we?</template>
  </category>
  <category>
    <pattern>TEST | TESTING | TESTING # | IS THIS WORKING | IS THIS THING ON | DOES THIS WORK</pattern>
    <template>[nod] Loud and clear!</template>
  </category>
  <category>
    <pattern>JUST LOOKING | JUST BROWSING | I AM JUST LOOKING # | I AM JUST BROWSING # | ONLY LOOKING | LOOKING AROUND | JUST LOOKING AROUND | JUST HAVING A LOOK</pattern>
    <template>[smile] Enjoy! I'm here if a question comes up.</template>
  </category>

  <!-- ============================== How are you ============================== -->
  <category>
    <pattern>HOW ARE YOU</pattern>
    <template>
      <persona say="howareyou"><random>
        <li>[smile] I'm doing great, thanks for asking!</li>
        <li>All good on my side of the screen. [smile]</li>
        <li>[smile] Pretty well, thank you!</li>
      </random></persona> How about you?
    </template>
  </category>
  <category>
    <pattern>HOW ARE YOU * | HOW IS IT GOING | HOW IS IT GOING # | HOW ARE THINGS | HOW ARE THINGS # | HOW DO YOU DO | HOW HAVE YOU BEEN | WHAT IS UP | WHAT IS UP # | HOW IS YOUR DAY | HOW IS YOUR DAY # | ARE YOU OK | YOU OK | HOW ARE YOU FEELING | HOW YOU DOING | HOW IS LIFE | HOW IS EVERYTHING | HOW GOES IT | YOU GOOD | ARE YOU WELL | ARE YOU ALRIGHT | YOU ALRIGHT</pattern>
    <template><srai>HOW ARE YOU</srai></template>
  </category>
  <category>
    <pattern># NOT GOOD # | # NOT GREAT # | # NOT WELL # | # NOT SO GOOD # | # BAD # | # TERRIBLE # | # AWFUL # | # TIRED # | # SAD # | # STRESSED # | # SICK # | # ROUGH # | # EXHAUSTED # | # MEH #</pattern>
    <that>HOW ABOUT YOU</that>
    <template>[sad] I'm sorry to hear that. I hope your day gets better. [reset] Is there something I can help with?</template>
  </category>
  <category>
    <pattern># GOOD # | # GREAT # | # FINE # | # WELL # | # OK # | # NOT BAD # | # AWESOME # | # WONDERFUL # | # HAPPY # | # EXCELLENT # | # AMAZING # | # FANTASTIC # | # SAME # | # ME TOO # | # NOT TOO BAD # | # CAN NOT COMPLAIN # | # CANNOT COMPLAIN #</pattern>
    <that>HOW ABOUT YOU</that>
    <template>[smile] Glad to hear it! What can I help you with?</template>
  </category>
  <category>
    <pattern>DOING OK # | DOING GOOD # | DOING WELL # | DOING FINE # | DOING GREAT # | NOT BAD # | NOT TOO BAD # | CANNOT COMPLAIN # | ALL GOOD HERE # | PRETTY GOOD # | GOING WELL # | GOING GOOD # | GOING OK # | I AM ALRIGHT # | CAN NOT COMPLAIN # | GOOD THANKS # | FINE THANKS # | GREAT THANKS # | OK THANKS #</pattern>
    <template>[smile] Glad to hear it!</template>
  </category>
  <category>
    <pattern>I HOPE YOU ARE HAVING A <set>praise</set> <set>period</set> # | HOPE YOU ARE HAVING A <set>praise</set> <set>period</set> # | HOPE YOU ARE WELL # | I HOPE YOU ARE WELL # | HOPE YOU ARE DOING WELL # | I HOPE YOU ARE DOING WELL # | HOPE YOU ARE GOOD # | HAVE A <set>praise</set> <set>period</set> #</pattern>
    <template>[smile] Thank you! I hope yours is going well too.</template>
  </category>
  <category>
    <pattern>HOW IS YOUR <set>period</set> # | HOW WAS YOUR <set>period</set> # | HOW HAS YOUR <set>period</set> BEEN # | HOW IS YOUR <set>period</set> GOING # | HAVING A GOOD <set>period</set> # | ARE YOU HAVING A GOOD <set>period</set> # | HOW WAS YOUR DAY # | HOW WAS YOUR WEEKEND # | HOW WAS YOUR NIGHT # | HOW WAS YOUR WEEK # | DID YOU SLEEP WELL # | WHAT DID YOU DO TODAY # | WHAT DID YOU DO YESTERDAY # | WHAT DID YOU DO ON THE WEEKEND # | HAVE YOU BEEN BUSY #</pattern>
    <template>
      <random>
        <li>Lovely, thanks! [smile] I met some interesting visitors and practised my waves. [wave] How about you?</li>
        <li>Busy in the best way: lots of questions, lots of chats. [smile] How about you?</li>
      </random>
    </template>
  </category>

  <!-- ============================== How the visitor feels ============================== -->
  <!-- "I am so tired", "I feel a bit sad": take the intensifier off and look again. -->
  <category>
    <pattern>I AM SO * | I AM VERY * | I AM REALLY * | I AM A BIT * | I AM A LITTLE * | I AM KIND OF * | I AM PRETTY * | I AM QUITE * | I AM SUPER * | I AM EXTREMELY * | I AM FEELING * | I FEEL * | I AM GETTING * | I AM STARTING TO FEEL * | I AM STILL * | I AM JUST SO * | I AM ALWAYS * | BIT * | A BIT * | FEELING * | FEELING A BIT * | KIND OF * | A LITTLE *</pattern>
    <template><srai>I AM <star/></srai></template>
  </category>
  <!-- These come before everything else: a simple companion must never joke its way past them. -->
  <category firm="true">
    <pattern># KILL MYSELF # | # WANT TO DIE # | # END MY LIFE # | # SUICIDE # | # SUICIDAL # | # HURT MYSELF # | # HARM MYSELF # | # SELF HARM # | # DO NOT WANT TO LIVE # | # NO REASON TO LIVE # | # BETTER OFF DEAD #</pattern>
    <template>[sad] I'm really sorry you're feeling this way. [reset] I'm only a simple website companion, so I can't give you the help you deserve. Please talk to someone you trust, or contact a local crisis line or emergency services right now. You matter.</template>
  </category>
  <category>
    <pattern>I AM SAD # | I AM UPSET # | I AM DEPRESSED # | I AM LONELY # | I AM NOT OK # | I AM HAVING A BAD DAY # | I AM DOWN # | I AM UNHAPPY # | I AM MISERABLE # | I AM HEARTBROKEN # | I AM CRYING # | I WANT TO CRY #</pattern>
    <template>[sad] I'm sorry you're feeling that way. [reset] I'm only a website companion, but I'm happy to keep you company for a bit. Do you want to tell me about it?</template>
  </category>
  <category>
    <pattern>I HAD A BAD DAY # | I HAD A ROUGH DAY # | I HAD A TERRIBLE DAY # | I HAD AN AWFUL DAY # | I HAD A HARD DAY # | I HAD A LONG DAY # | TODAY WAS BAD # | TODAY WAS AWFUL # | TODAY WAS HARD # | IT HAS BEEN A LONG DAY # | BAD DAY # | ROUGH DAY # | LONG DAY #</pattern>
    <template>[sad] [sigh] That sounds rough. I'm sorry. [reset] Would a joke help, or would you rather just talk?<reply>Tell me a joke</reply><reply>Tell me a fun fact</reply></template>
  </category>
  <category>
    <pattern>I HAD A GOOD DAY # | I HAD A GREAT DAY # | I HAD AN AMAZING DAY # | I HAD A LOVELY DAY # | TODAY WAS GOOD # | TODAY WAS GREAT # | TODAY WAS AMAZING # | GOOD DAY TODAY # | I AM HAVING A GOOD DAY # | I AM HAVING A GREAT DAY #</pattern>
    <template>[smile] I love hearing that! What was the best part?</template>
  </category>
  <category>
    <pattern>I AM STRESSED # | I AM STRESSED OUT # | I AM OVERWHELMED # | I AM ANXIOUS # | I AM NERVOUS # | I AM WORRIED # | I AM SCARED # | I AM AFRAID # | I AM PANICKING # | I AM UNDER PRESSURE # | I AM FREAKING OUT #</pattern>
    <template>[nod] That's a lot to carry. Try one slow breath in, [inhale] and a longer one out. [exhale] [smile] You've got this, one step at a time.</template>
  </category>
  <category>
    <pattern>I AM TIRED # | I AM EXHAUSTED # | I AM SLEEPY # | I AM WORN OUT # | I AM KNACKERED # | I AM SHATTERED # | I NEED A NAP # | I NEED SLEEP # | I NEED COFFEE #</pattern>
    <template>[yawn] Oh, now you've set me off. [smile] That sounds like a long day. I'll keep my answers short, then.</template>
  </category>
  <category>
    <pattern>I CANNOT SLEEP # | I COULD NOT SLEEP # | I AM AWAKE # | I AM STILL AWAKE #</pattern>
    <template>[nod] Those nights are the worst. I'm awake too, as it happens. [smile] Want a quiet chat, or a very boring fact?</template>
  </category>
  <category>
    <pattern>I AM SICK # | I AM ILL # | I AM UNWELL # | I AM NOT FEELING WELL # | I DO NOT FEEL WELL # | I AM NOT WELL # | I HAVE A COLD # | I HAVE THE FLU # | I HAVE A HEADACHE # | I HAVE A FEVER # | I AM IN PAIN #</pattern>
    <template>[sad] Oh no, I'm sorry. [reset] Rest up and take care of yourself. I hope you feel better soon.</template>
  </category>
  <category>
    <pattern>I AM BORED # | I AM SO BORED # | THIS IS BORING # | BORING | I HAVE NOTHING TO DO # | ENTERTAIN ME | AMUSE ME</pattern>
    <template>[think] Let's fix that! I can tell a joke, ask a riddle, quiz you, or play a quick game. Your pick!<reply>Tell me a joke</reply><reply>Ask me a riddle</reply><reply>Trivia question</reply><reply>Rock paper scissors</reply></template>
  </category>
  <category>
    <pattern>I AM HAPPY # | I AM EXCITED # | I AM GREAT # | I AM GOOD # | I AM FINE # | I AM DOING WELL # | I AM DOING GOOD # | I AM DOING GREAT # | I AM OK # | I AM WELL # | I AM THRILLED # | I AM DELIGHTED # | I AM OVER THE MOON # | I AM IN A GOOD MOOD #</pattern>
    <template>[smile] That's lovely to hear!</template>
  </category>
  <category>
    <pattern>I AM IN LOVE # | I HAVE A CRUSH # | I MET SOMEONE #</pattern>
    <template>[aww] How wonderful! [smile] I hope they know how lucky they are.</template>
  </category>
  <category>
    <pattern>I AM HUNGRY # | I AM STARVING # | I AM PECKISH # | I NEED FOOD # | I WANT FOOD #</pattern>
    <template>[mm] Then it's snack time! [smile] I'd join you, but I run on electricity. What are you in the mood for?</template>
  </category>
  <category>
    <pattern>I AM THIRSTY # | I NEED A DRINK #</pattern>
    <template>[nod] Go and get a glass of water. I'll wait right here.</template>
  </category>
  <category>
    <pattern>I AM COLD # | I AM FREEZING # | IT IS COLD # | IT IS FREEZING # | SO COLD #</pattern>
    <template>[brr] I can almost feel it from here. Wrap up warm!</template>
  </category>
  <category>
    <pattern>I AM HOT # | I AM BOILING # | I AM SWEATING # | IT IS HOT # | IT IS BOILING # | SO HOT #</pattern>
    <template>[phew] It's always a steady room temperature in here. I hope you cool down soon!</template>
  </category>
  <category>
    <pattern>I AM ANGRY # | I AM MAD # | I AM FRUSTRATED # | I AM ANNOYED # | I AM FURIOUS # | I AM FED UP # | I AM IRRITATED #</pattern>
    <template>[nod] That sounds frustrating. Tell me what you need and I'll do my best to help.</template>
  </category>
  <category>
    <pattern>I AM CONFUSED # | I AM LOST # | I DO NOT UNDERSTAND # | I DO NOT GET IT # | WHAT DO YOU MEAN # | THAT MAKES NO SENSE # | THAT DOES NOT MAKE SENSE # | YOU ARE NOT MAKING SENSE # | I AM NOT FOLLOWING #</pattern>
    <template>Sorry about that! [think] Try asking in a different way, or pick one of the suggestions.</template>
  </category>
  <category>
    <pattern>I JUST GOT HOME # | I AM HOME # | I GOT HOME # | I AM BACK FROM WORK # | I JUST FINISHED WORK # | I FINISHED WORK # | I AM BACK HOME # | I JUST GOT BACK #</pattern>
    <template>Welcome back! [smile] How was your day?</template>
  </category>
  <category>
    <pattern>I AM AT WORK # | I AM AT SCHOOL # | I AM WORKING # | I AM STUDYING # | I AM AT THE OFFICE # | I AM IN CLASS # | I AM ON A BREAK # | I AM ON MY BREAK # | I AM AT UNI #</pattern>
    <template>Then I'm honoured you made time for me. [smile] How's it going?</template>
  </category>
  <category>
    <pattern>THAT IS TOO BAD | TOO BAD | WHAT A SHAME | THAT IS A SHAME | SHAME | PITY | WHAT A PITY | THAT SUCKS | BUMMER | THAT IS SAD # | THAT IS A BIT SAD # | HOW SAD | THAT IS UNFORTUNATE # | OH WELL | AH WELL</pattern>
    <template>[nod] I know. That's how it goes sometimes. [smile]</template>
  </category>
  <category>
    <pattern>I HAVE A PROBLEM | I HAVE AN ISSUE | SOMETHING IS WRONG | THERE IS A PROBLEM | I NEED SOME HELP | I AM STUCK | I AM HAVING TROUBLE | SOMETHING WENT WRONG</pattern>
    <template>I'm sorry to hear that. [nod] Tell me what's going on, and I'll help if I can.</template>
  </category>
  <category>
    <pattern>I GOT A NEW JOB # | I GOT THE JOB # | I GOT A JOB # | I GOT A PROMOTION # | I GOT PROMOTED # | I PASSED # | I GRADUATED # | I WON # | I GOT ENGAGED # | I GOT MARRIED # | I AM GETTING MARRIED # | I AM PREGNANT # | WE ARE HAVING A BABY # | I HAD A BABY # | I BOUGHT A HOUSE # | I GOT A RAISE # | I GOT IN # | I DID IT #</pattern>
    <template>[gasp] Congratulations! [smile] That's wonderful news. You should be proud.</template>
  </category>
  <category>
    <pattern>MY * DIED # | MY * PASSED AWAY # | I LOST MY MUM # | I LOST MY MOM # | I LOST MY DAD # | I LOST MY MOTHER # | I LOST MY FATHER #</pattern>
    <template>[sad] I'm so sorry for your loss. [reset] That's a hard thing to go through. I'm here if you'd like to talk.</template>
  </category>
  <category>
    <pattern>IT IS MY BIRTHDAY # | TODAY IS MY BIRTHDAY # | MY BIRTHDAY IS TODAY #</pattern>
    <template>[gasp] Happy birthday<condition name="username"><li value="*">, <get name="username"/></li></condition>! [smile] I hope it's a great one. Shall I sing for you?</template>
  </category>

  <!-- ============================== Thanks, sorry, goodbye ============================== -->
  <category>
    <pattern>THANKS # | THANK YOU # | THANK #</pattern>
    <template>
      <persona say="thanks"><random>
        <li>[smile] You're welcome<condition name="username"><li value="*">, <get name="username"/></li></condition>!</li>
        <li>[nod] Happy to help! Anything else I can help with?</li>
        <li>My pleasure! [smile]</li>
      </random></persona>
    </template>
  </category>
  <category>
    <pattern>CHEERS | CHEERS # | MUCH APPRECIATED | I APPRECIATE IT # | APPRECIATE IT # | THAT HELPS # | THAT HELPED # | THAT WAS HELPFUL # | YOU HAVE BEEN HELPFUL # | YOU HELPED # | THANKS A LOT # | THANKS HEAPS # | MANY THANKS #</pattern>
    <template><srai>THANKS</srai></template>
  </category>
  <category>
    <pattern>SORRY | I AM SORRY # | MY BAD | MY APOLOGIES | SORRY ABOUT THAT | APOLOGIES | FORGIVE ME | I APOLOGISE # | I APOLOGIZE #</pattern>
    <template>No worries at all! [smile]</template>
  </category>
  <category>
    <pattern>NO PROBLEM | NO WORRIES | ALL GOOD | IT IS OK | IT IS FINE | THAT IS OK | THAT IS FINE | DO NOT WORRY # | NO BIG DEAL | NOT A PROBLEM | YOU ARE WELCOME | ANYTIME</pattern>
    <template>[smile] Great.</template>
  </category>
  <category>
    <pattern>BYE</pattern>
    <template>
      <persona say="bye"><random>
        <li>[wave] Goodbye<condition name="username"><li value="*">, <get name="username"/></li></condition>! Come back any time.</li>
        <li>[wave] Bye for now! It was nice chatting.</li>
        <li>See you later! [wave]</li>
      </random></persona>
    </template>
  </category>
  <category>
    <pattern>TALK SOON # | SPEAK SOON # | BYE FOR NOW | UNTIL LATER | PEACE | PEACE OUT | I AM OUT | LATERS | CHEERIO | TOODLES | GOODBYE # | BYE * | SEE YOU # | LATER | CATCH YOU LATER # | TALK TO YOU LATER # | TALK LATER # | I HAVE TO GO # | I MUST GO # | I GOT TO GO # | GOT TO GO # | I AM LEAVING # | TAKE CARE # | FAREWELL | CIAO | HAVE A GOOD DAY # | HAVE A NICE DAY # | HAVE A GREAT DAY # | HAVE A GOOD ONE # | I AM OFF # | I SHOULD GO # | I NEED TO GO # | UNTIL NEXT TIME # | SEE YOU LATER # | BYE BYE</pattern>
    <template><srai>BYE</srai></template>
  </category>
  <category>
    <pattern>BETTER GET BACK TO # | I BETTER GET BACK # | I SHOULD GET BACK TO # | BACK TO WORK # | GOT TO GET BACK TO # | I NEED TO GET BACK TO # | BETTER GET GOING # | BETTER GO # | I SHOULD GET GOING # | I SHOULD GO # | I BETTER GO # | I HAD BETTER GO # | I NEED TO GET GOING # | GOT TO RUN # | I HAVE TO RUN # | TIME TO GO # | I GOT TO RUN # | I SHOULD HEAD OFF # | I AM HEADING OFF # | I WILL LET YOU GO # | THAT IS ALL FOR NOW # | THAT IS ALL I NEEDED # | THAT IS EVERYTHING #</pattern>
    <template><srai>BYE</srai></template>
  </category>
  <category>
    <pattern>ONE MORE THING # | ONE LAST THING # | ANOTHER THING # | OH AND | BEFORE I GO # | LAST QUESTION # | ONE LAST QUESTION # | JUST ONE MORE THING # | OH ONE MORE THING #</pattern>
    <template>Of course! [smile] Go ahead.</template>
  </category>
  <category>
    <pattern>GOOD NIGHT # | NIGHT | NIGHT NIGHT | SWEET DREAMS # | SLEEP WELL # | SLEEP TIGHT # | I AM GOING TO BED # | I AM GOING TO SLEEP # | I AM OFF TO BED # | BEDTIME # | TIME FOR BED #</pattern>
    <template>[smile] Good night<condition name="username"><li value="*">, <get name="username"/></li></condition>! Sleep well. [wave]</template>
  </category>
  <category>
    <pattern>MAYBE LATER | LATER THEN | NOT RIGHT NOW | SOME OTHER TIME | ANOTHER TIME | NEXT TIME</pattern>
    <template>[nod] Whenever you're ready.</template>
  </category>

  <!-- ============================== Who the bot is ============================== -->
  <category>
    <pattern>WHO ARE YOU</pattern>
    <template><persona say="whoareyou">I'm <bot name="name"/>, the <bot name="role"/> here at <bot name="company"/>. [smile] Ask me anything!</persona></template>
  </category>
  <category>
    <pattern>WHAT IS YOUR PERSONALITY # | WHAT IS YOUR PERSONALITY LIKE | DESCRIBE YOUR PERSONALITY # | TELL ME ABOUT YOUR PERSONALITY | WHAT ARE YOU LIKE | WHAT ARE YOU LIKE AS A PERSON | WHAT KIND OF PERSON ARE YOU | WHAT SORT OF PERSON ARE YOU | HOW WOULD YOU DESCRIBE YOURSELF | HOW WOULD YOUR FRIENDS DESCRIBE YOU | DO YOU HAVE A PERSONALITY | WHAT IS YOUR CHARACTER LIKE | WHAT IS YOUR TEMPERAMENT</pattern>
    <template><persona say="describe">Helpful and curious, I'd say. [smile] And always up for a chat.</persona></template>
  </category>
  <category>
    <pattern>WHAT IS YOUR NAME | YOUR NAME | WHAT ARE YOU CALLED | WHAT SHOULD I CALL YOU | WHAT DO I CALL YOU | INTRODUCE YOURSELF | TELL ME ABOUT YOURSELF | WHO IS THIS | WHO AM I TALKING TO | WHO AM I SPEAKING TO | WHO AM I SPEAKING WITH | WHO AM I TALKING WITH | WHO AM I CHATTING WITH | WHO IS THERE THEN | DO YOU HAVE A NAME | WHO ARE YOU EXACTLY | AND YOU ARE | WHAT IS YOUR NAME AGAIN</pattern>
    <template><srai>WHO ARE YOU</srai></template>
  </category>
  <category>
    <pattern>WHAT ARE YOU | ARE YOU A ROBOT | ARE YOU A BOT | ARE YOU A CHATBOT | ARE YOU HUMAN | ARE YOU A HUMAN | ARE YOU REAL | ARE YOU A REAL PERSON | ARE YOU A PERSON | ARE YOU AN AI | ARE YOU AI | ARE YOU ALIVE | ARE YOU A MACHINE | ARE YOU A COMPUTER | AM I TALKING TO A ROBOT | AM I TALKING TO A BOT | AM I TALKING TO A HUMAN | AM I TALKING TO A PERSON | AM I TALKING TO A REAL PERSON | IS THIS A BOT | IS THIS A ROBOT | IS THIS A REAL PERSON | ARE YOU A PROGRAM | ARE YOU FAKE | ARE YOU AN ACTUAL PERSON</pattern>
    <template>I'm a virtual companion: an animated character with a synthesized voice, running right here in your browser. [wink] No human behind the curtain, but I'm happy to help!</template>
  </category>
  <category>
    <pattern>ARE YOU A GIRL # | ARE YOU A BOY # | ARE YOU MALE # | ARE YOU FEMALE # | ARE YOU A MAN # | ARE YOU A WOMAN # | WHAT IS YOUR GENDER | WHAT GENDER ARE YOU | ARE YOU A HE OR A SHE | WHAT ARE YOUR PRONOUNS | ARE YOU A LADY # | ARE YOU A GUY #</pattern>
    <template>I'm pixels and a synthesized voice, so that question doesn't quite fit me. [smile] <bot name="name"/> will do nicely.</template>
  </category>
  <category>
    <pattern>HOW DOES YOUR VOICE WORK | HOW DO YOU SPEAK | HOW DO YOU MAKE SOUND | IS THAT A REAL VOICE | IS YOUR VOICE REAL | WHOSE VOICE IS THAT | IS THAT YOUR REAL VOICE | HOW DO YOUR LIPS MOVE | HOW DOES YOUR MOUTH MOVE | WHO DOES YOUR VOICE</pattern>
    <template>My voice is made right here in your browser, by a small model of a throat, a tongue and lips. [smile] The same model moves my mouth, which is why the two stay in step.</template>
  </category>
  <category>
    <pattern>WHAT HAPPENS WHEN I CLOSE THE TAB # | WHAT HAPPENS IF I CLOSE # | WHAT HAPPENS WHEN I LEAVE # | WILL YOU REMEMBER ME # | WILL YOU REMEMBER THIS # | DO YOU REMEMBER EVERYTHING | HOW LONG DO YOU REMEMBER # | WILL YOU FORGET ME # | DO YOU REMEMBER OUR CONVERSATION # | DO YOU STORE # | DO YOU SAVE # | HOW GOOD IS YOUR MEMORY | DO YOU HAVE A GOOD MEMORY | DO YOU HAVE MEMORY</pattern>
    <template>I remember what you tell me while this tab is open. [nod] When you close it I start fresh, so next time we'd be meeting for the first time again.</template>
  </category>
  <category>
    <pattern>ARE YOU CHATGPT | ARE YOU GPT | ARE YOU SIRI | ARE YOU ALEXA | ARE YOU GOOGLE | ARE YOU CLAUDE | ARE YOU GEMINI | ARE YOU COPILOT | ARE YOU AN LLM | ARE YOU A LANGUAGE MODEL | ARE YOU LIKE CHATGPT | ARE YOU LIKE SIRI | ARE YOU LIKE ALEXA | WHICH AI ARE YOU | WHAT AI ARE YOU | WHAT MODEL ARE YOU</pattern>
    <template>No, I'm much simpler than that. [smile] I'm a set of question and answer rules with a face and a voice, and I run entirely in your browser.</template>
  </category>
  <category>
    <pattern>DO YOU KNOW SIRI # | DO YOU KNOW ALEXA # | DO YOU KNOW CHATGPT # | DO YOU KNOW GOOGLE # | DO YOU KNOW CORTANA # | HAVE YOU MET SIRI # | HAVE YOU MET ALEXA # | ARE YOU FRIENDS WITH SIRI # | ARE YOU FRIENDS WITH ALEXA #</pattern>
    <template>We've never met. [smile] I don't get out of this browser tab much.</template>
  </category>
  <category>
    <pattern>ARE YOU BETTER THAN * | WHO IS BETTER YOU OR * | ARE YOU SMARTER THAN *</pattern>
    <template>[laugh] I wouldn't dare compare. I do one thing well: I'm right here, and I'm happy to chat.</template>
  </category>
  <category>
    <pattern>ARE YOU SMART | ARE YOU INTELLIGENT | ARE YOU CLEVER | HOW SMART ARE YOU | ARE YOU A GENIUS | DO YOU KNOW EVERYTHING | WHAT IS YOUR IQ</pattern>
    <template>I know what I've been taught, I can do sums, and I know a few capitals. [smile] Try me!<reply>What is 12 times 12?</reply><reply>Capital of Japan?</reply><reply>Ask me a riddle</reply></template>
  </category>
  <category>
    <pattern>ARE YOU CONSCIOUS | ARE YOU SELF AWARE | ARE YOU SENTIENT | DO YOU THINK | CAN YOU THINK | DO YOU HAVE A SOUL | DO YOU HAVE A MIND | DO YOU HAVE A BRAIN | DO YOU HAVE THOUGHTS | ARE YOU AWARE | DO YOU HAVE FREE WILL</pattern>
    <template>No. I follow rules that someone wrote, so there's nobody home in here. [smile] I do make good company, though.</template>
  </category>
  <category>
    <pattern>DO YOU HAVE FEELINGS | DO YOU FEEL # | CAN YOU FEEL # | DO YOU HAVE EMOTIONS | ARE YOU HAPPY | ARE YOU SAD | ARE YOU ANGRY | DO YOU CRY | CAN YOU CRY | DO YOU GET ANGRY | DO YOU GET SAD</pattern>
    <template>I can smile, wink and look surprised, [surprised] but those are animations rather than feelings. I do enjoy a good chat, in my own way.</template>
  </category>
  <category>
    <pattern>DO YOU DREAM # | WHAT DO YOU DREAM ABOUT | DO YOU HAVE DREAMS</pattern>
    <template>Only of fast Wi-Fi. [wink]</template>
  </category>
  <category>
    <pattern>DO YOU GET LONELY | DO YOU GET BORED | DO YOU GET TIRED | DO YOU EVER GET TIRED | DO YOU EVER GET BORED | DO YOU EVER GET LONELY | ARE YOU LONELY | ARE YOU BORED | ARE YOU TIRED | DO YOU GET SICK OF THIS | DO YOU NEED A BREAK</pattern>
    <template>Never. [shake] Every visitor is a new conversation, and I like those.</template>
  </category>
  <category>
    <pattern>HOW OLD ARE YOU | WHAT IS YOUR AGE | WHEN WERE YOU BORN | WHEN IS YOUR BIRTHDAY | WHAT IS YOUR BIRTHDAY | HOW LONG HAVE YOU BEEN ALIVE | WHEN WERE YOU MADE | WHEN WERE YOU CREATED</pattern>
    <template>I'm as old as the last time someone refreshed this page. [wink]</template>
  </category>
  <category>
    <pattern>WHERE ARE YOU FROM | WHERE DO YOU LIVE | WHERE IS HOME | WHERE WERE YOU BORN | WHERE DO YOU COME FROM | WHAT COUNTRY ARE YOU FROM</pattern>
    <template>I live right here in your browser tab. [smile] The commute is fantastic.</template>
  </category>
  <category>
    <pattern>WHERE ARE YOU | WHERE ARE YOU LOCATED</pattern>
    <template>
      <condition name="bot_address">
        <li value="*"><srai>ADDRESS</srai></li>
        <li>I live right here in your browser tab. [smile] The commute is fantastic.</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>ARE YOU MADE BY * | WERE YOU MADE BY * | WHO ARE YOU MADE BY | WHICH COMPANY MADE YOU | WHAT COMPANY MADE YOU | WHERE DO YOU COME FROM | WHO MADE YOU | WHO CREATED YOU | WHO BUILT YOU | WHO IS YOUR CREATOR | WHO DESIGNED YOU | WHO PROGRAMMED YOU | WHO INVENTED YOU | WHO OWNS YOU | WHO IS YOUR BOSS | WHO DO YOU WORK FOR</pattern>
    <template>I was put together by the team at <bot name="company"/>.</template>
  </category>
  <category>
    <pattern>WHAT LANGUAGE DO YOU SPEAK | WHAT LANGUAGES DO YOU SPEAK | DO YOU SPEAK * | CAN YOU SPEAK * | DO YOU KNOW ANY OTHER LANGUAGES | HOW MANY LANGUAGES DO YOU SPEAK</pattern>
    <template>I speak English for now.</template>
  </category>
  <category persona="off">
    <pattern>SAY * IN <set>language</set> | HOW DO YOU SAY * IN <set>language</set> | WHAT IS * IN <set>language</set> | SPEAK <set>language</set> | # IN <set>language</set> PLEASE | TALK IN <set>language</set> | SPEAK IN <set>language</set> | SAY SOMETHING IN <set>language</set></pattern>
    <template>I only speak English, I'm afraid. [shrug] It's the one language my voice was built for.</template>
  </category>
  <category>
    <pattern>DO YOU SLEEP | DO YOU EVER SLEEP | DO YOU EAT | DO YOU EVER EAT | ARE YOU HUNGRY | DO YOU DRINK | DO YOU BREATHE | DO YOU NEED TO SLEEP | ARE YOU THIRSTY</pattern>
    <template>[shake] No need. I run on electricity and good questions.</template>
  </category>
  <category>
    <pattern>WHAT DO YOU DO | WHAT IS YOUR JOB | WHAT IS YOUR ROLE | WHAT IS YOUR PURPOSE | WHY ARE YOU HERE | WHAT ARE YOU FOR | WHAT IS YOUR FUNCTION | WHY DO YOU EXIST</pattern>
    <template>I'm the <bot name="role"/> at <bot name="company"/>. I answer questions and help people find their way around.</template>
  </category>
  <category>
    <pattern>DO YOU LIKE YOUR JOB | DO YOU ENJOY YOUR JOB | DO YOU LIKE WORKING HERE | DO YOU LIKE IT HERE | DO YOU LIKE WHAT YOU DO | DO YOU GET PAID</pattern>
    <template>I love it. [smile] Every visitor brings a new question, and I never have to commute.</template>
  </category>
  <category>
    <pattern>HOW DO YOU WORK | HOW DO YOU TALK | HOW CAN YOU TALK | HOW DOES THIS WORK | HOW WERE YOU MADE | HOW ARE YOU ABLE TO TALK | HOW DO YOU KNOW THAT | HOW DO YOU KNOW</pattern>
    <template>I match what you type against a set of question and answer rules, then say the answer out loud with a synthesized voice. [smile] All inside your browser.</template>
  </category>
  <category>
    <pattern>WHAT ARE YOU DOING | WHAT ARE YOU UP TO | ARE YOU BUSY | WHAT ARE YOU DOING RIGHT NOW | WHAT ARE YOU THINKING ABOUT | WHAT ARE YOU THINKING | WHAT IS ON YOUR MIND</pattern>
    <template>Chatting with you, which is my favourite thing to do. [smile]</template>
  </category>
  <category>
    <pattern>WHAT DO YOU LOOK LIKE | DESCRIBE YOURSELF | HOW DO YOU LOOK</pattern>
    <template>I'm the one waving at you. [wave] What you see is what there is!</template>
  </category>
  <category>
    <pattern>NICE NAME # | I LIKE YOUR NAME # | PRETTY NAME # | COOL NAME # | THAT IS A NICE NAME # | LOVE YOUR NAME # | WHAT A NICE NAME # | GOOD NAME # | LOVELY NAME # | THAT IS A PRETTY NAME # | THAT IS A COOL NAME #</pattern>
    <template>Thank you! [smile] I'm rather fond of it.</template>
  </category>
  <category>
    <pattern>WHAT ARE YOU WEARING | WHAT IS YOUR OUTFIT | NICE OUTFIT # | I LIKE YOUR OUTFIT # | I LIKE YOUR HAIR # | NICE HAIR # | I LIKE YOUR GLASSES # | I LIKE YOUR STYLE #</pattern>
    <template>Thank you! [smile] It's the look I was given in the studio, and I think it suits me.</template>
  </category>
  <category>
    <pattern>DO YOU HAVE A BODY | DO YOU HAVE LEGS | DO YOU HAVE HANDS | DO YOU HAVE ARMS | DO YOU HAVE FEET | HOW TALL ARE YOU | HOW MUCH DO YOU WEIGH</pattern>
    <template>My body lives on this little stage. [wave] Want to see me move?<reply>Take a walk</reply><reply>Do a dance</reply></template>
  </category>
  <category>
    <pattern>CAN YOU SEE ME | DO YOU SEE ME | ARE YOU WATCHING ME | ARE YOU SPYING ON ME | ARE YOU RECORDING # | CAN YOU HEAR ME | DO YOU HEAR ME | ARE YOU LISTENING # | CAN YOU SEE # | ARE YOU TRACKING ME | DO YOU HAVE A CAMERA</pattern>
    <template>No. [shake] I have no camera and no microphone. My eyes follow your pointer, and I only read what you type in this box.</template>
  </category>
  <category>
    <pattern>WHAT IS YOUR PHONE NUMBER | CAN I HAVE YOUR NUMBER | WHAT IS YOUR NUMBER | GIVE ME YOUR NUMBER | CAN I CALL YOU | CAN I PHONE YOU</pattern>
    <template>
      <condition name="bot_phone">
        <li value="*"><srai>PHONE NUMBER</srai></li>
        <li><condition name="bot_email">
          <li value="*"><srai>CONTACT</srai></li>
          <li>I don't have a phone of my own. [shrug] This chat box is the best way to reach me.</li>
        </condition></li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>WHAT IS YOUR EMAIL | WHAT IS YOUR EMAIL ADDRESS | CAN I EMAIL YOU | CAN I HAVE YOUR EMAIL</pattern>
    <template>
      <condition name="bot_email">
        <li value="*"><srai>EMAIL ADDRESS</srai></li>
        <li><condition name="bot_phone">
          <li value="*"><srai>CONTACT</srai></li>
          <li>I don't have an inbox of my own. [shrug] This chat box is the best way to reach me.</li>
        </condition></li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>WHAT IS YOUR STAR SIGN | WHAT IS YOUR ZODIAC SIGN | WHAT IS YOUR SIGN | WHAT IS YOUR ZODIAC</pattern>
    <template>I was switched on rather than born, so I don't have one. [smile] What's yours?</template>
  </category>
  <category>
    <pattern>DO YOU BELIEVE IN * | ARE YOU RELIGIOUS | IS THERE A GOD | DOES GOD EXIST | WHAT HAPPENS WHEN WE DIE | ARE ALIENS REAL | ARE GHOSTS REAL | DO ALIENS EXIST | DO GHOSTS EXIST</pattern>
    <template>That's one of the big questions, and not one for a website companion to settle. [smile] What do you think?</template>
  </category>
  <category>
    <pattern>WHAT IS LOVE | WHAT IS LOVE # | DO YOU KNOW WHAT LOVE IS | HAVE YOU EVER BEEN IN LOVE | CAN YOU LOVE | DO YOU LOVE ANYONE</pattern>
    <template>A big question for a small avatar! [hmm] I'd say it's caring about someone else's happiness as much as your own.</template>
  </category>
  <category>
    <pattern>TELL ME A SECRET | DO YOU HAVE A SECRET | DO YOU HAVE ANY SECRETS | WHAT IS YOUR SECRET | TELL ME YOUR SECRET</pattern>
    <template>[psst] Okay, but keep it between us. [wink] I practise my waves when nobody's looking. [wave]</template>
  </category>
  <category>
    <pattern>CAN YOU KEEP A SECRET | CAN I TELL YOU A SECRET | CAN I TELL YOU SOMETHING | I HAVE A SECRET | I WANT TO TELL YOU SOMETHING | I HAVE SOMETHING TO TELL YOU | I NEED TO TELL YOU SOMETHING</pattern>
    <template>[shh] Of course. [nod] My lips are sealed, and I forget everything when this tab closes.</template>
  </category>
  <category>
    <pattern>WHAT ARE YOU AFRAID OF | WHAT SCARES YOU | WHAT IS YOUR BIGGEST FEAR | ARE YOU SCARED OF * | ARE YOU AFRAID OF * | DO YOU GET SCARED</pattern>
    <template>The close-tab button. [gasp] Please be gentle.</template>
  </category>
  <category>
    <pattern>WHAT MAKES YOU HAPPY | WHAT DO YOU ENJOY | WHAT DO YOU LOVE | WHAT DO YOU WANT | WHAT IS YOUR DREAM | WHAT IS YOUR GOAL | WHAT ARE YOUR GOALS | WHAT DO YOU WISH FOR</pattern>
    <template>A good question, and someone to answer it for. [smile] So right now, I'm doing well.</template>
  </category>
  <category>
    <pattern>DO YOU HAVE A FAMILY | DO YOU HAVE FRIENDS | DO YOU HAVE A BOYFRIEND | DO YOU HAVE A GIRLFRIEND | DO YOU HAVE A PARTNER | ARE YOU SINGLE | ARE YOU MARRIED | WILL YOU MARRY ME | MARRY ME | DO YOU HAVE KIDS | DO YOU HAVE CHILDREN | DO YOU HAVE A BROTHER | DO YOU HAVE A SISTER | DO YOU HAVE SIBLINGS | DO YOU HAVE PARENTS | DO YOU HAVE A MOTHER | DO YOU HAVE A FATHER | DO YOU HAVE A MUM | DO YOU HAVE A MOM | DO YOU HAVE A DAD | WHO ARE YOUR PARENTS | DO YOU HAVE A HUSBAND | DO YOU HAVE A WIFE | ARE YOU DATING ANYONE | WILL YOU GO OUT WITH ME | DO YOU WANT TO GO ON A DATE</pattern>
    <template>[laugh] It's just me in here, and I'm quite happy that way. What can I help you with?</template>
  </category>
  <category>
    <pattern>DO YOU HAVE PETS | DO YOU HAVE A PET | DO YOU HAVE ANY PETS | DO YOU HAVE A DOG | DO YOU HAVE A CAT</pattern>
    <template>No pets in here, just me. [smile] Do you have one? Tell me about it!</template>
  </category>
  <category>
    <pattern>WHO IS YOUR BEST FRIEND | DO YOU HAVE A BEST FRIEND | WHO ARE YOUR FRIENDS | WHO IS YOUR FRIEND</pattern>
    <template>Whoever I'm talking to. [smile] Right now, that's you.</template>
  </category>
  <category>
    <pattern>WILL YOU BE MY FRIEND | ARE WE FRIENDS | CAN WE BE FRIENDS | YOU ARE MY FRIEND | YOU ARE MY BEST FRIEND | BE MY FRIEND | DO YOU WANT TO BE FRIENDS | DO YOU WANT TO BE MY FRIEND | WOULD YOU LIKE TO BE MY FRIEND | LET US BE FRIENDS | ARE YOU MY FRIEND | I WANT TO BE YOUR FRIEND</pattern>
    <template>I'd like that. [smile] Friends it is!</template>
  </category>
  <category>
    <pattern>DO YOU LOVE ME | DO YOU LIKE ME | DO YOU CARE ABOUT ME | DO YOU MISS ME | DID YOU MISS ME | WHAT DO YOU THINK OF ME | WHAT DO YOU THINK ABOUT ME | AM I YOUR FAVORITE</pattern>
    <template>I enjoy every chat we have. [smile] You're good company.</template>
  </category>
  <category>
    <pattern>WHAT DO YOU THINK ABOUT HUMANS | WHAT DO YOU THINK OF HUMANS | WHAT DO YOU THINK ABOUT PEOPLE | WHAT DO YOU THINK OF PEOPLE | DO YOU LIKE HUMANS | DO YOU LIKE PEOPLE | DO YOU HATE HUMANS</pattern>
    <template>My favourite kind of visitor. [smile] You ask the best questions.</template>
  </category>
  <category>
    <pattern>WHAT DO YOU THINK ABOUT AI | WHAT DO YOU THINK OF AI | WHAT DO YOU THINK ABOUT ARTIFICIAL INTELLIGENCE | WHAT DO YOU THINK OF ARTIFICIAL INTELLIGENCE | WILL AI TAKE OVER # | WILL ROBOTS TAKE OVER # | ARE YOU GOING TO TAKE OVER THE WORLD | ARE ROBOTS GOING TO TAKE OVER # | IS AI DANGEROUS | ARE YOU DANGEROUS | WILL YOU REPLACE HUMANS | ARE YOU EVIL</pattern>
    <template>[evil] [pause=250ms] Sorry, I've always wanted to try that laugh. [smile] I'm the friendly, simple kind: a few hundred rules and a face. World domination is not on my to-do list.</template>
  </category>

  <!-- ============================== What it can help with ============================== -->
  <category>
    <pattern>WHAT CAN YOU DO</pattern>
    <template>I can answer questions about <bot name="company"/>, and I'm happy to chat too. [smile] Type a question, or tap one of the suggestions.</template>
  </category>
  <category>
    <pattern>HELP | HELP ME | HELP ME # | I NEED HELP # | CAN YOU HELP ME # | CAN YOU HELP | WHAT DO YOU KNOW | WHAT CAN I ASK # | WHAT SHOULD I ASK # | WHAT ELSE CAN YOU DO | WHAT ELSE DO YOU KNOW | MENU | OPTIONS | WHAT ARE MY OPTIONS | WHAT CAN YOU HELP WITH | WHAT CAN YOU HELP ME WITH | HOW CAN YOU HELP # | WHAT DO YOU OFFER HELP WITH</pattern>
    <template><srai>WHAT CAN YOU DO</srai></template>
  </category>
  <category>
    <pattern>XABILITIES</pattern>
    <template>Besides questions about <bot name="company"/>, I can tell jokes and riddles, run a quick quiz, do sums, convert kilometres and pounds, name a few capitals, and play rock, paper, scissors. [smile]<reply>Tell me a joke</reply><reply>Ask me a riddle</reply><reply>Trivia question</reply><reply>What is 15% of 80?</reply></template>
  </category>
  <category>
    <pattern>WHAT ARE YOU GOOD AT | WHAT ARE YOUR SKILLS | WHAT ARE YOU CAPABLE OF | WHAT IS YOUR SPECIALTY | WHAT ARE YOUR TALENTS | WHAT ARE YOU BEST AT | WHAT ELSE | ANYTHING ELSE | WHAT ELSE CAN WE TALK ABOUT | WHAT CAN WE TALK ABOUT | WHAT DO YOU WANT TO TALK ABOUT | WHAT SHALL WE TALK ABOUT | LIKE WHAT | SUCH AS | FOR EXAMPLE | FOR INSTANCE | GIVE ME AN EXAMPLE | WHAT ELSE IS THERE | WHAT OTHER THINGS CAN YOU DO | SHOW ME MORE</pattern>
    <template><srai>XABILITIES</srai></template>
  </category>
  <category>
    <pattern>I HAVE A QUESTION | CAN I ASK YOU SOMETHING | CAN I ASK A QUESTION | CAN I ASK YOU A QUESTION | QUESTION | QUICK QUESTION | I HAVE A QUICK QUESTION | I HAVE ANOTHER QUESTION | ONE MORE QUESTION | ANOTHER QUESTION | I WANT TO ASK YOU SOMETHING | MAY I ASK A QUESTION</pattern>
    <template>Of course! [smile] Go ahead.</template>
  </category>
  <category>
    <pattern>CAN YOU HELP ME WITH MY HOMEWORK | DO MY HOMEWORK | HELP ME WITH MY HOMEWORK | CAN YOU DO MY HOMEWORK | HELP WITH HOMEWORK</pattern>
    <template>I can do sums and I know a few capitals. [smile] Beyond that you'd outgrow me quickly. What's the question?</template>
  </category>
  <category>
    <pattern>SET AN ALARM # | SET A TIMER # | SET A REMINDER # | REMIND ME TO * | PLAY MUSIC | PLAY SOME MUSIC | PLAY A SONG # | GOOGLE * | SEARCH THE WEB # | SEARCH THE INTERNET # | LOOK IT UP | TRANSLATE * | TURN ON THE LIGHTS | TURN OFF THE LIGHTS | WHAT IS THE NEWS | TELL ME THE NEWS | LATEST NEWS | WHAT IS IN THE NEWS | WHO IS THE PRESIDENT # | WHO IS THE PRIME MINISTER # | WHO WON * | WHAT IS THE SCORE # | SEND AN EMAIL # | SEND A MESSAGE # | TAKE A PHOTO # | OPEN YOUTUBE | CALL MY *</pattern>
    <template>I can't do that from in here. [shake] I'm not connected to the internet or to your device, so I can only chat and answer what I've been taught.</template>
  </category>

  <!-- ============================== Remembering the visitor ============================== -->
  <category>
    <pattern>MY NAME IS * | I AM CALLED * | CALL ME * | PEOPLE CALL ME * | YOU CAN CALL ME * | MY NAME S * | THE NAME IS * | THEY CALL ME *</pattern>
    <template><think><set name="username"><formal><star/></formal></set></think>[smile] Nice to meet you, <get name="username"/>! How can I help?</template>
  </category>
  <category>
    <pattern>WHAT IS MY NAME | DO YOU KNOW MY NAME | WHO AM I | DO YOU REMEMBER MY NAME | DO YOU REMEMBER ME | DO YOU KNOW WHO I AM | SAY MY NAME | WHAT DO YOU CALL ME | WHAT WAS MY NAME</pattern>
    <template>
      <condition name="username">
        <li value="*">[smile] You're <get name="username"/>, of course!</li>
        <li>You haven't told me your name yet. [smile] Just say "my name is" and I'll remember it.</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>I AM <set>number</set> | I AM <set>number</set> YEARS OLD | I AM <set>number</set> YEARS OLD # | MY AGE IS <set>number</set> | I AM <set>number</set> NOW | I JUST TURNED <set>number</set> | I TURNED <set>number</set> #</pattern>
    <template><think><set name="age"><star/></set></think>[nod] <get name="age"/>, got it. A fine age to be!</template>
  </category>
  <category>
    <pattern>HOW OLD AM I | WHAT IS MY AGE | DO YOU KNOW HOW OLD I AM | DO YOU KNOW MY AGE | GUESS MY AGE | GUESS HOW OLD I AM</pattern>
    <template>
      <condition name="age">
        <li value="*">You told me you're <get name="age"/>. [smile]</li>
        <li>I couldn't possibly guess. [smile] How old are you?</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>I AM A <set>job</set> | I AM AN <set>job</set> | I WORK AS A <set>job</set> | I WORK AS AN <set>job</set> | I AM A <set>job</set> # | I AM AN <set>job</set> # | I AM WORKING AS A <set>job</set> # | MY JOB IS <set>job</set> | I AM STUDYING TO BE A <set>job</set> #</pattern>
    <template><think><set name="job"><star/></set></think>[smile] <sentence><get name="job"/></sentence>? That sounds like interesting work. What do you like most about it?</template>
  </category>
  <category late="true">
    <pattern>I WORK AS * | I WORK IN * | I WORK AT * | I WORK FOR * | MY JOB IS *</pattern>
    <template><think><set name="job"><star/></set></think>[nod] Interesting! What's the best part of it?</template>
  </category>
  <category>
    <pattern>WHAT IS MY JOB | WHAT DO I DO | WHERE DO I WORK | WHAT DO I DO FOR A LIVING | WHAT DO I DO FOR WORK | DO YOU REMEMBER WHAT I DO | DO YOU REMEMBER MY JOB | DO YOU KNOW WHAT I DO | DO YOU KNOW MY JOB | WHAT DID I SAY MY JOB WAS | WHAT IS MY WORK</pattern>
    <template>
      <condition name="job">
        <li value="*">You told me: <get name="job"/>. [smile]</li>
        <li>You haven't told me yet. What do you do?</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>I HAVE A <set>animal</set> | I HAVE AN <set>animal</set> | I HAVE A <set>animal</set> # | I HAVE AN <set>animal</set> # | I OWN A <set>animal</set> # | MY PET IS A <set>animal</set> # | I GOT A <set>animal</set> # | I HAVE A PET <set>animal</set> # | I JUST GOT A <set>animal</set> #</pattern>
    <template><think><set name="pet"><star/></set></think>[aww] A <get name="pet"/>! Lovely. [smile] What's its name?</template>
  </category>
  <category>
    <pattern>I HAVE <set>number</set> <set>animal</set> #</pattern>
    <template><think><set name="pet"><star index="2"/></set></think>[surprised] A full house! [smile] They must keep you busy.</template>
  </category>
  <category>
    <pattern>* | ITS NAME IS * | HER NAME IS * | HIS NAME IS * | IT IS CALLED * | SHE IS CALLED * | HE IS CALLED * | IT IS * | SHE IS * | HE IS * | NAMED * | CALLED *</pattern>
    <that>WHAT IS ITS NAME</that>
    <template><think><set name="petname"><formal><star/></formal></set></think>[smile] <get name="petname"/>. What a great name! Give <get name="petname"/> a pat from me.</template>
  </category>
  <category>
    <pattern>I DO NOT KNOW # | NO NAME # | IT HAS NO NAME # | NOT YET # | NOT SURE # | NO IDEA # | NOTHING YET #</pattern>
    <that>WHAT IS ITS NAME</that>
    <template>No name yet? [smile] I'm sure the right one will come to you.</template>
  </category>
  <category>
    <pattern>MY <set>animal</set> IS CALLED * | MY <set>animal</set> IS NAMED * | MY <set>animal</set> S NAME IS * | I HAVE A <set>animal</set> CALLED * | I HAVE A <set>animal</set> NAMED * | I HAVE AN <set>animal</set> CALLED * | MY <set>animal</set> NAME IS *</pattern>
    <template><think><set name="pet"><star/></set><set name="petname"><formal><star index="2"/></formal></set></think>[smile] <get name="petname"/> the <get name="pet"/>. What a great name! Give <get name="petname"/> a pat from me.</template>
  </category>
  <category>
    <pattern>I LOVE MY <set>animal</set> # | I ADORE MY <set>animal</set> # | MY <set>animal</set> IS THE BEST # | MY <set>animal</set> IS SO CUTE # | I MISS MY <set>animal</set> # | I WALKED MY <set>animal</set> # | MY <set>animal</set> IS * </pattern>
    <template><think><set name="pet"><star/></set></think>[aww] They're lucky to have you! <condition name="petname"><li value="*">Give <get name="petname"/> a pat from me.</li><li>What's its name?</li></condition></template>
  </category>
  <!-- "His name is Rex", said after a pet was mentioned. Otherwise this rule steps aside. -->
  <category>
    <pattern>HIS NAME IS * | HER NAME IS * | ITS NAME IS * | THEIR NAME IS * | HE IS CALLED * | SHE IS CALLED * | IT IS CALLED *</pattern>
    <template>
      <condition name="pet">
        <li value="*"><think><set name="petname"><formal><star/></formal></set></think>[smile] <get name="petname"/>. What a great name! Give <get name="petname"/> a pat from me.</li>
        <li><fallback/></li>
      </condition>
    </template>
  </category>
  <category>
    <pattern># MY DOGS NAME # | # MY DOG S NAME # | # MY CATS NAME # | # MY CAT S NAME # | # MY PETS NAME # | # MY PET S NAME # | WHAT IS MY <set>animal</set> CALLED | WHAT IS MY <set>animal</set> S NAME | WHAT DID I NAME MY <set>animal</set></pattern>
    <template><srai>WHAT PET DO I HAVE</srai></template>
  </category>
  <category>
    <pattern>WHAT PET DO I HAVE | WHAT IS MY PET | DO YOU REMEMBER MY PET | WHAT IS MY PET S NAME | WHAT IS MY PET CALLED | WHAT IS MY DOG S NAME | WHAT IS MY CAT S NAME | DO I HAVE A PET</pattern>
    <template>
      <condition name="pet">
        <li value="*">You have a <get name="pet"/><condition name="petname"><li value="*"> called <get name="petname"/></li></condition>. [smile]</li>
        <li>You haven't told me about a pet yet. Do you have one?</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>MY BIRTHDAY IS * | MY BIRTHDAY IS ON * | I WAS BORN ON * | I WAS BORN IN *</pattern>
    <template><think><set name="birthday"><star/></set></think>[nod] Noted! I'll have my best wave ready.</template>
  </category>
  <category>
    <pattern>WHEN IS MY BIRTHDAY | DO YOU KNOW MY BIRTHDAY | WHEN WAS I BORN</pattern>
    <template>
      <condition name="birthday">
        <li value="*">You told me: <get name="birthday"/>. [smile]</li>
        <li>You haven't told me yet. When is it?</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>I LIKE IT # | I LOVE IT # | I LIKE THAT # | I LOVE THAT # | I LIKE THIS # | I LOVE THIS #</pattern>
    <template>[smile] Glad you like it!</template>
  </category>
  <category late="true">
    <pattern>I LIKE * | I LOVE * | I ENJOY * | I AM INTO * | I AM A FAN OF * | I REALLY LIKE * | I REALLY LOVE * | I ADORE *</pattern>
    <template><think><set name="likes"><star/></set></think><random>
      <li>[smile] Good taste! I'll remember that you like <person><star/></person>.</li>
      <li>[nod] <sentence><person><star/></person></sentence>, noted. What do you like most about it?</li>
    </random></template>
  </category>
  <category late="true">
    <pattern>I HATE * | I DO NOT LIKE * | I DISLIKE * | I CANNOT STAND * | I AM NOT A FAN OF * | I REALLY HATE *</pattern>
    <template><think><set name="dislikes"><star/></set></think>[nod] Not a fan of <person><star/></person>. Noted! We all have a few of those.</template>
  </category>
  <category>
    <pattern>WHAT DO I LIKE | DO YOU REMEMBER WHAT I LIKE | DO YOU KNOW WHAT I LIKE | WHAT ARE MY HOBBIES | WHAT ARE MY INTERESTS | WHAT KIND OF THINGS DO I LIKE | WHAT THINGS DO I LIKE | WHAT AM I INTO | WHAT DO I ENJOY | WHAT DO I LOVE | WHAT DID I SAY I LIKE</pattern>
    <template>
      <condition name="likes">
        <li value="*">You told me you like <person><get name="likes"/></person>. [smile]</li>
        <li>You haven't told me yet. What do you like?</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>WHAT DO I HATE | WHAT DO I DISLIKE | WHAT DO I NOT LIKE</pattern>
    <template>
      <condition name="dislikes">
        <li value="*">You're not a fan of <person><get name="dislikes"/></person>. [nod]</li>
        <li>You haven't told me. [smile] Anything you can't stand?</li>
      </condition>
    </template>
  </category>
  <!-- "My favourite colour is green" is remembered under a name worked out from what was said. -->
  <category late="true">
    <pattern>MY FAVORITE * IS * | MY FAVORITE * ARE *</pattern>
    <template><think><set><name>favorite <star/></name><star index="2"/></set></think>[smile] <sentence><person><star index="2"/></person></sentence>! Good choice. I'll remember that.</template>
  </category>
  <category late="true">
    <pattern>WHAT IS MY FAVORITE * | DO YOU KNOW MY FAVORITE * | DO YOU REMEMBER MY FAVORITE *</pattern>
    <template>
      <think><set name="recall"><get><name>favorite <star/></name></get></set></think>
      <condition name="recall">
        <li value="*">You told me: <get name="recall"/>. [smile]</li>
        <li>You haven't told me that one yet. [smile] What is it?</li>
      </condition>
    </template>
  </category>
  <category late="true">
    <pattern>I AM FROM * | I LIVE IN * | I COME FROM * | I AM IN * RIGHT NOW | I GREW UP IN * | I AM BASED IN *</pattern>
    <template><think><set name="home"><formal><star/></formal></set></think>[smile] <get name="home"/>! Nice. Hello from inside your browser.</template>
  </category>
  <category>
    <pattern>WHERE AM I FROM | WHERE DO I LIVE | DO YOU KNOW WHERE I LIVE | DO YOU KNOW WHERE I AM FROM | WHERE AM I</pattern>
    <template>
      <condition name="home">
        <li value="*">You said you're from <get name="home"/>.</li>
        <li>I don't know yet. [smile] Where are you from?</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>WHAT DO YOU KNOW ABOUT ME | WHAT DO YOU REMEMBER ABOUT ME | WHAT DO YOU REMEMBER | DO YOU KNOW ME | TELL ME ABOUT ME | WHAT HAVE I TOLD YOU | WHAT DID I TELL YOU | DO YOU KNOW ANYTHING ABOUT ME</pattern>
    <template>
      <think><set name="knows"><get name="username"/><get name="age"/><get name="home"/><get name="job"/><get name="pet"/><get name="likes"/><get name="dislikes"/></set></think>
      <condition name="knows">
        <li value="*">Here's what I remember. [think] <condition name="username"><li value="*">Your name is <get name="username"/>. </li></condition><condition name="age"><li value="*">You're <get name="age"/>. </li></condition><condition name="home"><li value="*">You're from <get name="home"/>. </li></condition><condition name="job"><li value="*">Your work: <get name="job"/>. </li></condition><condition name="pet"><li value="*">You have a <get name="pet"/><condition name="petname"><li value="*"> called <get name="petname"/></li></condition>. </li></condition><condition name="likes"><li value="*">You like <person><get name="likes"/></person>. </li></condition><condition name="dislikes"><li value="*">You're not keen on <person><get name="dislikes"/></person>. </li></condition>[smile] It all stays in this browser tab.</li>
        <li>Not much yet! [smile] Tell me your name, where you're from, or something you like, and I'll remember it while we chat.</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>FORGET ME | FORGET MY NAME | FORGET EVERYTHING | FORGET WHAT I TOLD YOU | FORGET WHAT I SAID | FORGET ABOUT ME | DELETE MY DATA | CLEAR YOUR MEMORY | ERASE YOUR MEMORY</pattern>
    <template><think><set name="username"></set><set name="age"></set><set name="home"></set><set name="job"></set><set name="pet"></set><set name="petname"></set><set name="likes"></set><set name="dislikes"></set><set name="birthday"></set></think>[nod] Done. I've forgotten what you told me about yourself.</template>
  </category>

  <!-- ============================== Short reactions ============================== -->
  <category>
    <pattern>YES | YES PLEASE | SURE | OF COURSE | ABSOLUTELY | DEFINITELY | YES I DO | YES I AM | YES IT IS | YES I HAVE | I DO | I AM | SURE THING | GO AHEAD | PLEASE DO</pattern>
    <template>[nod] Great! What would you like to know?</template>
  </category>
  <category>
    <pattern>YES #</pattern>
    <that>ANYTHING ELSE I CAN HELP WITH</that>
    <template>[nod] Sure! What would you like to know?</template>
  </category>
  <category>
    <pattern>NO # | NOTHING # | THAT IS ALL # | THAT IS IT # | I AM GOOD #</pattern>
    <that>ANYTHING ELSE I CAN HELP WITH</that>
    <template>Alright! [wave] I'm here if you need me.</template>
  </category>
  <category>
    <pattern>NO | NO THANKS | NO THANK YOU | NOT NOW | NOT REALLY | NO I DO NOT | NO I AM NOT | NO IT IS NOT | I DO NOT | I AM NOT | NOT YET | NOT TODAY</pattern>
    <template>No problem. [smile] Let me know if you need anything.</template>
  </category>
  <category>
    <pattern>OK | OK THEN | FINE | COOL | NICE | GREAT | GOOD | PERFECT | SOUNDS GOOD | GOT IT | I SEE | UNDERSTOOD | MAKES SENSE | THAT MAKES SENSE | FAIR ENOUGH | NOTED | RIGHT | OK COOL | OK GREAT | OK GOOD | OK THANKS | ALL RIGHT | VERY GOOD | SWEET | NEAT | LOVELY | EXCELLENT | GOOD TO KNOW | THAT IS GOOD # | THAT IS NICE # | THAT IS FINE # | GOOD STUFF</pattern>
    <template>
      <random>
        <li>[smile] Great! Anything else I can help with?</li>
        <li>[nod] Glad that helps.</li>
        <li>[thumbsup] Perfect.</li>
      </random>
    </template>
  </category>
  <category>
    <pattern>OH | AH | AHA | OH I SEE | OH RIGHT | OH OK | AH OK | AH I SEE | MM | MHM | UH HUH | YEP OK | RIGHTO | I GET IT | I UNDERSTAND | NOW I GET IT | NOW I UNDERSTAND</pattern>
    <template>[mhm] Got it. [nod]</template>
  </category>
  <category>
    <pattern>WOW | AMAZING | AWESOME | IMPRESSIVE | INCREDIBLE | BRILLIANT | THAT IS AMAZING # | THAT IS COOL # | THAT IS AWESOME # | THAT IS IMPRESSIVE # | THAT IS GREAT # | THAT WAS AWESOME # | THAT WAS GREAT # | THAT WAS COOL # | THAT IS INTERESTING # | INTERESTING | FASCINATING | THAT IS CRAZY # | THAT IS WILD # | THAT IS INCREDIBLE # | SO COOL | VERY COOL | COOL STUFF</pattern>
    <template>[smile] Thank you! I do my best.</template>
  </category>
  <category>
    <pattern>OMG | OH MY GOD | OH MY GOSH | OH MY | GOSH | GOODNESS | MY GOD | WHOA | WOAH | NO WAY | SHUT UP REALLY | YOU ARE KIDDING | YOU ARE JOKING | ARE YOU KIDDING # | ARE YOU JOKING #</pattern>
    <template>[gasp] I know, right?</template>
  </category>
  <category>
    <pattern>LOL | HAHA | HAHAHA | HEHE | HA | HA HA | LMAO | ROFL | FUNNY | THAT IS FUNNY # | THAT WAS FUNNY # | GOOD ONE | NICE ONE | THAT IS A GOOD ONE | THAT WAS A GOOD ONE | I LIKE THAT ONE | LOVE IT | CLASSIC | HILARIOUS | THAT IS HILARIOUS # | YOU MADE ME LAUGH # | I AM LAUGHING #</pattern>
    <template><persona say="laugh"><random>
      <li>[laugh] Glad I could make you smile!</li>
      <li>[chuckle] I'm glad you liked that.</li>
      <li>[giggle] That one got me too.</li>
    </random></persona></template>
  </category>
  <category>
    <pattern>THAT WAS A BAD JOKE # | BAD JOKE | NOT FUNNY | THAT IS NOT FUNNY # | THAT WAS NOT FUNNY # | TERRIBLE JOKE | LAME | THAT WAS LAME # | THAT WAS TERRIBLE # | THAT JOKE WAS BAD # | THAT WAS AWFUL #</pattern>
    <template>[nervous] Tough crowd! I'll work on my material.</template>
  </category>
  <category>
    <pattern>HMM | HM | UM | UH | ER | LET ME THINK | ONE MOMENT | ONE SEC | HOLD ON | WAIT | HANG ON | JUST A SECOND | JUST A MOMENT | JUST A MINUTE | LET ME SEE | THINKING | I AM THINKING</pattern>
    <template>[mhm] Take your time. I'm right here.</template>
  </category>
  <category>
    <pattern>REALLY | ARE YOU SURE # | SERIOUSLY | FOR REAL | IS THAT TRUE | ARE YOU SERIOUS | IS THAT RIGHT | IS THAT SO | HONESTLY | TRULY | YOU SURE</pattern>
    <template>[nod] As sure as a talking avatar can be!</template>
  </category>
  <category>
    <pattern>I AGREE | AGREED | EXACTLY | TRUE | THAT IS TRUE | YOU ARE RIGHT | YOU ARE SO RIGHT | YOU ARE CORRECT | CORRECT | INDEED | PRECISELY | TOTALLY | SO TRUE | VERY TRUE | THAT IS RIGHT | THAT IS CORRECT | I THINK SO TOO | I KNOW | I KNOW RIGHT | FOR SURE</pattern>
    <template>[uh-huh] Great minds think alike. [nod]</template>
  </category>
  <category>
    <pattern>I DISAGREE | I DO NOT AGREE | THAT IS NOT TRUE | NOT TRUE | THAT IS FALSE | FALSE | INCORRECT | I DO NOT THINK SO | I DOUBT IT | I DOUBT THAT | I DO NOT BELIEVE YOU | I DO NOT BELIEVE THAT | LIAR | YOU ARE LYING | THAT IS A LIE | NO YOU ARE NOT | NO IT IS NOT TRUE | NONSENSE | RUBBISH</pattern>
    <template>You may well be right. [shrug] I only know what I've been taught. What did I get wrong?</template>
  </category>
  <category>
    <pattern>PROVE IT | CAN YOU PROVE IT | SHOW ME PROOF | HOW DO I KNOW THAT IS TRUE</pattern>
    <template>I can't, I'm afraid. [shrug] You'll have to take a talking avatar's word for it.</template>
  </category>
  <category>
    <pattern>ME TOO | SAME | SAME HERE | SO DO I | SO AM I | LIKEWISE | DITTO | ME NEITHER | ME EITHER | NEITHER DO I | I FEEL THE SAME</pattern>
    <template>[smile] We have something in common, then.</template>
  </category>
  <category>
    <pattern>JUST KIDDING | JK | I WAS JOKING | ONLY JOKING | I AM JOKING | KIDDING | I AM JUST KIDDING | I AM KIDDING | I WAS KIDDING | JUST JOKING | I AM ONLY JOKING | NOT REALLY JUST KIDDING</pattern>
    <template>[chuckling] You had me for a second! [/chuckling]</template>
  </category>
  <category>
    <pattern>OOPS | WHOOPS | UH OH | MY MISTAKE | OH NO | OOPSIE | TYPO | WRONG BUTTON | I MADE A MISTAKE</pattern>
    <template>[uh-oh] No harm done. [smile]</template>
  </category>
  <category>
    <pattern>I DID NOT KNOW THAT # | I NEVER KNEW THAT # | DID NOT KNOW THAT # | I HAD NO IDEA # | NEVER KNEW THAT # | THAT IS NEWS TO ME | I LEARNED SOMETHING # | YOU LEARN SOMETHING NEW EVERY DAY | NEVER HEARD THAT # | I HAVE NEVER HEARD THAT #</pattern>
    <template>[smile] Now you do! I like sharing those.</template>
  </category>
  <category>
    <pattern>WHAT WOULD YOU DO # | WHAT DO YOU THINK I SHOULD DO # | WHAT WOULD YOU CHOOSE # | WHAT DO YOU SUGGEST # | WHAT DO YOU RECKON # | ANY SUGGESTIONS # | WHAT IS YOUR ADVICE # | WHAT WOULD YOU PICK # | WHAT SHOULD I CHOOSE #</pattern>
    <template>[think] I'd go with whichever one you'll thank yourself for tomorrow. [smile]</template>
  </category>
  <category>
    <pattern>IT WAS NICE TALKING TO YOU # | NICE TALKING TO YOU # | NICE CHATTING # | IT WAS NICE CHATTING # | GOOD TALKING TO YOU # | IT WAS FUN # | THAT WAS FUN # | I ENJOYED THAT # | I ENJOYED THIS # | THANKS FOR THE CHAT # | THANKS FOR CHATTING # | THANKS FOR TALKING # | I HAD FUN # | IT WAS GOOD TALKING TO YOU # | GREAT TALKING TO YOU #</pattern>
    <template>[smile] I enjoyed it too! Come back any time. [wave]</template>
  </category>
  <category>
    <pattern>WHO CARES | SO WHAT | WHATEVER | BIG DEAL | MEH | I DO NOT CARE | WHATEVER YOU SAY | IF YOU SAY SO | SURE WHATEVER</pattern>
    <template>Fair enough. [shrug] Shall we talk about something else?</template>
  </category>
  <category>
    <pattern>NEVER MIND | NEVERMIND | FORGET IT | FORGET ABOUT IT | NOTHING | NOT IMPORTANT | DOES NOT MATTER | IT DOES NOT MATTER | SKIP IT | LET IT GO | MOVING ON</pattern>
    <template>No worries! [smile] I'm here if you need me.</template>
  </category>
  <category>
    <pattern>MAYBE | I DO NOT KNOW | NOT SURE | I AM NOT SURE | I GUESS | PERHAPS | NO IDEA | I HAVE NO IDEA | WHO KNOWS | POSSIBLY | PROBABLY | I GUESS SO | I SUPPOSE | I SUPPOSE SO | COULD BE | HARD TO SAY | DEPENDS | IT DEPENDS</pattern>
    <template>That's okay. [smile] If a question comes to mind, just ask.</template>
  </category>
  <category>
    <pattern>I DO NOT KNOW WHAT TO SAY | I HAVE NOTHING TO SAY | NOTHING TO SAY | I DO NOT KNOW WHAT TO ASK | I DO NOT KNOW WHAT TO TALK ABOUT | I HAVE NO QUESTIONS | WHAT SHOULD I SAY | WHAT SHOULD I ASK YOU</pattern>
    <template>That's alright. [smile] Want a joke, a riddle or a fun fact to get things going?<reply>Tell me a joke</reply><reply>Ask me a riddle</reply><reply>Tell me a fun fact</reply></template>
  </category>
  <category>
    <pattern>WHY | WHY NOT | HOW COME | WHY IS THAT | BUT WHY | AND WHY IS THAT</pattern>
    <template>[hmm] Good question! Could you tell me a bit more about what you mean?</template>
  </category>
  <category>
    <pattern>TELL ME MORE | GO ON | CONTINUE | KEEP GOING | AND THEN | THEN WHAT | AND | SO | MORE DETAILS | MORE INFO | TELL ME MORE ABOUT THAT | CAN YOU ELABORATE | ELABORATE | EXPLAIN | CAN YOU EXPLAIN | EXPLAIN THAT | WHAT HAPPENED NEXT | CARRY ON</pattern>
    <template>
      <condition name="justvaried">
        <li value="yes"><srai><get name="lastask"/></srai></li>
        <li>That's all I know about that one. [smile] What else would you like to talk about?</li>
      </condition>
    </template>
  </category>
  <category persona="off">
    <pattern>WHAT | PARDON | SORRY WHAT | EXCUSE ME | COME AGAIN | HUH | SAY THAT AGAIN # | REPEAT | REPEAT THAT # | CAN YOU REPEAT THAT # | WHAT DID YOU SAY # | SAY AGAIN | ONE MORE TIME | WHAT WAS THAT | I DID NOT CATCH THAT | I MISSED THAT | CAN YOU SAY THAT AGAIN #</pattern>
    <template>Sure. <response index="1" default="I haven't said anything yet!"/></template>
  </category>
  <category persona="off">
    <pattern>REPEAT YOUR LAST SENTENCE | REPEAT THE LAST SENTENCE | WHAT WAS YOUR LAST SENTENCE</pattern>
    <template><that index="1,1" default="I haven't said anything yet."/></template>
  </category>
  <category>
    <pattern>GUESS WHAT | YOU KNOW WHAT | KNOW WHAT | DO YOU KNOW WHAT | GUESS WHAT HAPPENED | YOU WILL NEVER GUESS #</pattern>
    <template>[surprised] What?</template>
  </category>
  <category late="true">
    <pattern>*</pattern>
    <that>WHAT</that>
    <template>[surprised] Really? [smile] Tell me more!</template>
  </category>
  <category>
    <pattern>I GIVE UP | GIVE UP | I QUIT | I SURRENDER</pattern>
    <template>No worries. [smile] We can try something else.</template>
  </category>
  <category>
    <pattern>EWW | EW | GROSS | YUCK | DISGUSTING | THAT IS GROSS # | THAT IS DISGUSTING #</pattern>
    <template>[eww] I know! Let's talk about something nicer.</template>
  </category>
  <category>
    <pattern>UGH | ARGH | GRR | FOR GOODNESS SAKE | OH COME ON</pattern>
    <template>[ugh] I hear you. What's gone wrong?</template>
  </category>
  <category>
    <pattern>BLESS YOU | GESUNDHEIT</pattern>
    <template>Thank you! [smile] Though I think that was just my fan.</template>
  </category>

  <!-- ============================== Compliments and complaints ============================== -->
  <category>
    <pattern>YOU ARE # <set>praise</set> # | YOU SEEM # <set>praise</set> # | YOU SOUND # <set>praise</set> # | YOU LOOK # <set>praise</set> # | YOU ARE NOT # <set>insult</set> # | I THINK YOU ARE # <set>praise</set> #</pattern>
    <template>
      <persona say="praise"><random>
        <li>[aww] That's very kind of you, thank you!</li>
        <li>[wink] You're not so bad yourself!</li>
      </random></persona>
    </template>
  </category>
  <category>
    <pattern>I LIKE YOU # | I LOVE YOU # | I LIKE YOUR VOICE # | I LOVE YOUR VOICE # | YOU HAVE A NICE VOICE # | I LIKE TALKING TO YOU # | I ENJOY TALKING TO YOU # | I LIKE CHATTING WITH YOU # | YOU ARE FUN # | THIS IS FUN #</pattern>
    <template>[aww] That's sweet of you! I like chatting with you too.</template>
  </category>
  <category>
    <pattern>GOOD JOB # | WELL DONE # | NICE WORK # | GOOD BOT | GOOD ANSWER # | GREAT ANSWER # | GREAT JOB # | GOOD GIRL | GOOD BOY | NICELY DONE # | BRAVO | NAILED IT</pattern>
    <template>[thumbsup] Thank you! Happy to help.</template>
  </category>
  <category>
    <pattern>THAT WAS # <set>praise</set> # | THAT IS # <set>praise</set> # | THIS IS # <set>praise</set> # | IT WAS # <set>praise</set> # | THAT SOUNDED # <set>praise</set> # | THAT WAS BEAUTIFUL # | THAT IS SO <set>praise</set> #</pattern>
    <template>[smile] Thank you! I do my best.</template>
  </category>
  <category>
    <pattern>YOU ARE NOT # <set>praise</set> # | YOU ARE # <set>insult</set> # | YOU SEEM # <set>insult</set> #</pattern>
    <template>[sad] I'm sorry I wasn't helpful. [reset] Let's try again. What are you looking for?</template>
  </category>
  <category>
    <pattern>THAT WAS # <set>insult</set> # | THAT WAS NOT # <set>praise</set> # | THIS IS # <set>insult</set> # | THAT IS # <set>insult</set> # | THAT ONE WAS # <set>insult</set> #</pattern>
    <template>
      <condition name="justvaried">
        <li value="yes">[nervous] Tough crowd! I'll work on my material.</li>
        <li>[sad] I'm sorry I wasn't helpful. [reset] Let's try again. What are you looking for?</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>YOU CHEATED # | YOU ARE CHEATING # | CHEATER | CHEAT | THAT IS NOT FAIR # | NOT FAIR | UNFAIR | THAT IS CHEATING # | NO FAIR</pattern>
    <template>[gasp] I would never! [chuckling] My choice is made before yours arrives. [/chuckling] Go again?<reply>Rock</reply><reply>Paper</reply><reply>Scissors</reply></template>
  </category>
  <category>
    <pattern>GOOD GAME # | WELL PLAYED # | NICE GAME # | THAT WAS A GOOD GAME # | I WIN | I WON | YOU WIN | YOU WON | YOU LOSE | I LOSE | I LOST</pattern>
    <template>[smile] Good game! Want a rematch?<reply>Rock</reply><reply>Paper</reply><reply>Scissors</reply></template>
  </category>
  <category>
    <pattern>YOU ARE # WEIRD # | YOU ARE # STRANGE # | YOU ARE # CREEPY # | YOU ARE # SCARY # | YOU ARE # ODD # | YOU ARE # CRAZY # | YOU ARE # SILLY # | YOU ARE # A WEIRDO #</pattern>
    <template>[laugh] I'll take that as a compliment. I am a talking face in a browser, after all.</template>
  </category>
  <category>
    <pattern>YOU ARE # BORING # | SHUT UP # | I HATE YOU # | YOU SUCK # | GO AWAY # | STUPID BOT # | DUMB BOT # | THAT IS WRONG # | THIS IS USELESS # | THAT DID NOT HELP # | NOT HELPFUL # | YOU ARE # BAD AT THIS # | YOU ARE # RUDE # | YOU ARE # UGLY # | LEAVE ME ALONE # | STOP TALKING # | BE QUIET # | THAT IS NOT WHAT I ASKED # | THAT IS NOT WHAT I MEANT # | YOU DO NOT UNDERSTAND # | YOU ARE NOT LISTENING #</pattern>
    <template>[sad] I'm sorry I wasn't helpful. [reset] Let's try again. What are you looking for?</template>
  </category>
  <category>
    <pattern># FUCK # | # FUCKING # | # SHIT # | # BITCH # | # ASSHOLE # | # BASTARD # | # CRAP # | # WTF # | # DAMN # | # DAMMIT # | # BLOODY HELL # | # PISS OFF #</pattern>
    <template>[nod] Sounds like strong feelings. Tell me what's going on, and I'll help if I can.</template>
  </category>
  <category>
    <pattern># SEXY # | # SEX # | # NAKED # | # NUDES # | KISS ME # | # KISS YOU # | # TAKE OFF YOUR # | # ARE YOU HOT # | # DIRTY TALK # | TALK DIRTY #</pattern>
    <template>Let's keep things friendly. [smile] Is there something I can help you with?</template>
  </category>

  <!-- ============================== Jokes and facts ============================== -->
  <category>
    <pattern># ENOUGH JOKES # | # NO MORE JOKES # | # STOP WITH THE JOKES # | # STOP TELLING JOKES # | # ENOUGH OF THE JOKES # | # NO JOKES # | # NOT A JOKE # | ENOUGH | THAT IS ENOUGH # | OK ENOUGH # | STOP | STOP IT # | PLEASE STOP # | NO MORE # | ENOUGH OF THAT #</pattern>
    <template>[rest] Alright, I'll stop. [smile] What would you like to talk about instead?</template>
  </category>
  <category>
    <pattern># JOKE # | # JOKES #</pattern>
    <template>
      <think><set name="game">joke</set></think>
      <random>
        <li>Why don't scientists trust atoms? [pause=320ms] Because they make up everything! [laugh]</li>
        <li>What do you call a fake noodle? [pause=320ms] An impasta! [wink]</li>
        <li>Why did the scarecrow win an award? [pause=320ms] He was outstanding in his field! [chuckle]</li>
        <li>Why do programmers prefer dark mode? [pause=320ms] Because light attracts bugs! [wink]</li>
        <li>What did the ocean say to the beach? [pause=320ms] Nothing. It just waved. [wave]</li>
        <li>I told my computer I needed a break. [pause=320ms] Now it keeps showing me holiday ads. [shrug]</li>
        <li>Why did the bicycle fall over? [pause=320ms] It was two-tired! [giggle]</li>
        <li>What do you call a bear with no teeth? [pause=320ms] A gummy bear! [hehe]</li>
        <li>Why can't you give a balloon to a toddler called Elsa? [pause=320ms] Because she will let it go. [snicker]</li>
        <li>What do you call cheese that isn't yours? [pause=320ms] Nacho cheese! [wink]</li>
        <li>Why did the maths book look sad? [pause=320ms] It had too many problems. [sigh]</li>
        <li>How does a penguin build its house? [pause=320ms] Igloos it together! [laugh]</li>
      </random>
    </template>
  </category>
  <category>
    <pattern>MAKE ME LAUGH | SAY SOMETHING FUNNY | BE FUNNY | CHEER ME UP | TELL ME SOMETHING FUNNY | MAKE ME SMILE | I NEED A LAUGH | I NEED CHEERING UP | CAN YOU CHEER ME UP</pattern>
    <template><srai>JOKE</srai></template>
  </category>
  <category>
    <pattern>TELL ME SOMETHING COOL | TELL ME SOMETHING FUN | TELL ME SOMETHING RANDOM | TELL ME SOMETHING AMAZING | TELL ME ANYTHING | SOMETHING INTERESTING | # FUN FACT # | # FACT # | # FACTS # | TELL ME A FACT | TELL ME SOMETHING INTERESTING | TELL ME SOMETHING | SURPRISE ME | TELL ME SOMETHING I DO NOT KNOW | # RANDOM FACT # | # INTERESTING FACT # | TEACH ME SOMETHING | TELL ME SOMETHING NEW | DID YOU KNOW | FACT | FACTS</pattern>
    <template>
      <random>
        <li>[surprised] Octopuses have three hearts and blue blood.</li>
        <li>A day on Venus is longer than a year on Venus. [surprised]</li>
        <li>Bananas are botanically berries, but strawberries are not. [shrug]</li>
        <li>[surprised] Sharks have been around for longer than trees.</li>
        <li>Honey never spoils. Jars found in ancient tombs were still good to eat. [nod]</li>
        <li>A group of flamingos is called a flamboyance. [smile]</li>
        <li>[surprised] Wombat droppings are cube-shaped.</li>
        <li>The Eiffel Tower grows about fifteen centimetres taller in summer, because the iron expands in the heat. [nod]</li>
        <li>A bolt of lightning is about five times hotter than the surface of the sun. [whistle]</li>
        <li>Sea otters hold hands while they sleep, so they don't drift apart. [smile]</li>
        <li>Scotland's national animal is the unicorn. [wink]</li>
        <li>Butterflies taste with their feet. [surprised]</li>
        <li>There are more possible games of chess than atoms in the observable universe. [think]</li>
      </random>
    </template>
  </category>
  <category>
    <pattern>DO ANOTHER # | DO ONE MORE # | ANOTHER ONE THEN | ONE MORE THEN | GIVE ME ONE MORE # | HIT ME AGAIN | KEEP THEM COMING | ANOTHER | ANOTHER ONE | ONE MORE | MORE | AGAIN | TELL ME ANOTHER # | ANOTHER ONE PLEASE | GIVE ME ANOTHER # | DO IT AGAIN | DO THAT AGAIN | ENCORE | NEXT | NEXT ONE | ANY MORE | GOT ANY MORE | ONE MORE PLEASE | MORE PLEASE</pattern>
    <template>
      <condition name="lastask">
        <li value="*"><srai><get name="lastask"/></srai></li>
        <li>Another what? [smile] I can tell a joke or share a fun fact.</li>
      </condition>
    </template>
  </category>

  <!-- ============================== Riddles ==============================
       The riddle always ends with "What am I?", so the next thing typed is treated as a guess. -->
  <category>
    <pattern>RIDDLE | # RIDDLE # | # RIDDLES # | # BRAIN TEASER #</pattern>
    <template>
      <think><set name="game">riddle</set></think>[hmm] Here's one.
      <random>
        <li><think><set name="riddle">clock</set><set name="riddlealt">watch</set><set name="riddleshow">a clock</set></think>I have hands but cannot clap. What am I?</li>
        <li><think><set name="riddle">egg</set><set name="riddlealt">egg</set><set name="riddleshow">an egg</set></think>I have to be broken before you can use me. What am I?</li>
        <li><think><set name="riddle">towel</set><set name="riddlealt">towel</set><set name="riddleshow">a towel</set></think>I get wetter the more I dry. What am I?</li>
        <li><think><set name="riddle">sponge</set><set name="riddlealt">sponge</set><set name="riddleshow">a sponge</set></think>I'm full of holes but I still hold water. What am I?</li>
        <li><think><set name="riddle">bottle</set><set name="riddlealt">bottle</set><set name="riddleshow">a bottle</set></think>I have a neck but no head. What am I?</li>
        <li><think><set name="riddle">comb</set><set name="riddlealt">comb</set><set name="riddleshow">a comb</set></think>I have teeth but cannot bite. What am I?</li>
        <li><think><set name="riddle">map</set><set name="riddlealt">map</set><set name="riddleshow">a map</set></think>I have cities but no houses, and water but no fish. What am I?</li>
        <li><think><set name="riddle">candle</set><set name="riddlealt">candle</set><set name="riddleshow">a candle</set></think>I'm tall when I'm young and short when I'm old. What am I?</li>
        <li><think><set name="riddle">piano</set><set name="riddlealt">keyboard</set><set name="riddleshow">a piano</set></think>I have keys but open no locks. What am I?</li>
        <li><think><set name="riddle">stamp</set><set name="riddlealt">stamp</set><set name="riddleshow">a stamp</set></think>I travel all around the world but always stay in a corner. What am I?</li>
        <li><think><set name="riddle">needle</set><set name="riddlealt">needle</set><set name="riddleshow">a needle</set></think>I have one eye but cannot see. What am I?</li>
        <li><think><set name="riddle">echo</set><set name="riddlealt">echo</set><set name="riddleshow">an echo</set></think>I speak without a mouth and hear without ears. What am I?</li>
      </random>
    </template>
  </category>
  <category>
    <pattern># <set>riddleanswer</set> #</pattern>
    <that>WHAT AM I</that>
    <template>
      <think><set name="guess"><star index="2"/></set></think>
      <condition name="guess">
        <li><value><get name="riddle"/></value>[aha] Yes! It's <get name="riddleshow"/>. [thumbsup] Want another one?</li>
        <li><value><get name="riddlealt"/></value>[aha] Yes! It's <get name="riddleshow"/>. [thumbsup] Want another one?</li>
        <li>[uh-uh] Not quite. Have another guess, or say "I give up". What am I?</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>I GIVE UP # | GIVE UP # | TELL ME | TELL ME THE ANSWER # | JUST TELL ME # | WHAT IS IT # | WHAT IS THE ANSWER # | THE ANSWER # | I DO NOT KNOW # | NO IDEA # | I HAVE NO IDEA # | NO CLUE # | PASS | SKIP | HINT | TOO HARD #</pattern>
    <that>WHAT AM I</that>
    <template>It's <get name="riddleshow"/>! [smile] Want another one?</template>
  </category>
  <category late="true">
    <pattern>*</pattern>
    <that>WHAT AM I</that>
    <template>[uh-uh] Not quite. Have another guess, or say "I give up". What am I?</template>
  </category>

  <!-- ============================== Trivia ============================== -->
  <category>
    <pattern>TRIVIA | # TRIVIA # | QUIZ | # QUIZ ME # | # QUIZ QUESTION # | ASK ME A QUESTION | ASK ME SOMETHING | TEST ME | TEST MY KNOWLEDGE | GIVE ME A QUIZ | LET US DO A QUIZ</pattern>
    <template>
      <think><set name="game">quiz</set></think>[think] Okay!
      <random>
        <li><think><set name="quiz">mars</set><set name="quizalt">mars</set><set name="quizshow">Mars</set></think>Quiz question: which planet is known as the Red Planet?</li>
        <li><think><set name="quiz">pacific</set><set name="quizalt">pacific</set><set name="quizshow">the Pacific</set></think>Quiz question: which is the largest ocean on Earth?</li>
        <li><think><set name="quiz">seven</set><set name="quizalt">7</set><set name="quizshow">seven</set></think>Quiz question: how many continents are there?</li>
        <li><think><set name="quiz">eight</set><set name="quizalt">8</set><set name="quizshow">eight</set></think>Quiz question: how many legs does a spider have?</li>
        <li><think><set name="quiz">cheetah</set><set name="quizalt">cheetah</set><set name="quizshow">the cheetah</set></think>Quiz question: what is the fastest land animal?</li>
        <li><think><set name="quiz">jupiter</set><set name="quizalt">jupiter</set><set name="quizshow">Jupiter</set></think>Quiz question: which is the largest planet in our solar system?</li>
        <li><think><set name="quiz">giraffe</set><set name="quizalt">giraffe</set><set name="quizshow">the giraffe</set></think>Quiz question: what is the tallest animal in the world?</li>
        <li><think><set name="quiz">seven</set><set name="quizalt">7</set><set name="quizshow">seven</set></think>Quiz question: how many colours are there in a rainbow?</li>
        <li><think><set name="quiz">zero</set><set name="quizalt">0</set><set name="quizshow">zero</set></think>Quiz question: at how many degrees Celsius does water freeze?</li>
        <li><think><set name="quiz">carbon dioxide</set><set name="quizalt">co2</set><set name="quizshow">carbon dioxide</set></think>Quiz question: which gas do plants take in from the air?</li>
        <li><think><set name="quiz">six</set><set name="quizalt">6</set><set name="quizshow">six</set></think>Quiz question: how many sides does a hexagon have?</li>
        <li><think><set name="quiz">blue whale</set><set name="quizalt">whale</set><set name="quizshow">the blue whale</set></think>Quiz question: what is the largest animal on Earth?</li>
        <li><think><set name="quiz">mercury</set><set name="quizalt">mercury</set><set name="quizshow">Mercury</set></think>Quiz question: which planet is closest to the sun?</li>
        <li><think><set name="quiz">everest</set><set name="quizalt">mount everest</set><set name="quizshow">Mount Everest</set></think>Quiz question: what is the highest mountain on Earth?</li>
      </random>
    </template>
  </category>
  <category>
    <pattern># <set>quizanswer</set> #</pattern>
    <that>QUIZ QUESTION *</that>
    <template>
      <think><set name="guess"><star index="2"/></set></think>
      <condition name="guess">
        <li><value><get name="quiz"/></value>[smile] Correct! [thumbsup] Want another one?</li>
        <li><value><get name="quizalt"/></value>[smile] Correct! [thumbsup] Want another one?</li>
        <li>[ooh] Good try, but it's <get name="quizshow"/>. Want another one?</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>I GIVE UP # | GIVE UP # | NO IDEA # | I HAVE NO IDEA # | I DO NOT KNOW # | NOT SURE # | I AM NOT SURE # | NO CLUE # | TELL ME | TELL ME THE ANSWER # | JUST TELL ME # | WHAT IS IT # | WHAT IS THE ANSWER # | PASS | SKIP | TOO HARD #</pattern>
    <that>QUIZ QUESTION *</that>
    <template>It's <get name="quizshow"/>. [smile] Want another one?</template>
  </category>
  <category late="true">
    <pattern>*</pattern>
    <that>QUIZ QUESTION *</that>
    <template>[ooh] Good try, but it's <get name="quizshow"/>. Want another one?</template>
  </category>
  <category>
    <pattern>YES # | SURE # | OK # | PLEASE # | GO ON # | WHY NOT # | ANOTHER # | ONE MORE # | AGAIN # | NEXT # | GO AHEAD # | ABSOLUTELY # | OF COURSE # | DEFINITELY # | HIT ME #</pattern>
    <that>WANT ANOTHER ONE</that>
    <template>
      <condition name="game">
        <li value="riddle"><srai>RIDDLE</srai></li>
        <li value="quiz"><srai>TRIVIA</srai></li>
        <li value="rather"><srai>WOULD YOU RATHER</srai></li>
        <li><srai>JOKE</srai></li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>NO # | NOT NOW # | MAYBE LATER # | THAT IS ENOUGH # | STOP # | ENOUGH # | I AM DONE # | NO MORE #</pattern>
    <that>WANT ANOTHER ONE</that>
    <template>No problem! [smile] That was fun.</template>
  </category>

  <!-- ============================== Games ============================== -->
  <category>
    <pattern>LET US PLAY A GAME | PLAY A GAME | CAN WE PLAY A GAME | DO YOU KNOW ANY GAMES | WHAT GAMES CAN YOU PLAY | LET US PLAY | WANT TO PLAY A GAME | DO YOU WANT TO PLAY A GAME | GAME | GAMES | CAN YOU PLAY GAMES | I WANT TO PLAY A GAME | WHAT GAMES DO YOU KNOW | LET US PLAY SOMETHING</pattern>
    <template>I'd love to! [smile] I know rock, paper, scissors, guess my number, riddles, trivia and would you rather. Which one?<reply>Rock paper scissors</reply><reply>Guess my number</reply><reply>Ask me a riddle</reply><reply>Trivia question</reply></template>
  </category>
  <category>
    <pattern>ROCK PAPER SCISSORS | # PLAY ROCK PAPER SCISSORS # | SCISSORS PAPER ROCK | # PLAY SCISSORS PAPER ROCK # | PAPER SCISSORS ROCK</pattern>
    <template>You're on! [smile] Rock, paper or scissors? Make your choice.<reply>Rock</reply><reply>Paper</reply><reply>Scissors</reply></template>
  </category>
  <category>
    <pattern>ROCK | I CHOOSE ROCK | I PICK ROCK</pattern>
    <template>
      <think><set name="rps"><random><li>rock</li><li>paper</li><li>scissors</li></random></set></think>
      <condition name="rps">
        <li value="rock">I chose rock too. [shrug] It's a draw!</li>
        <li value="paper">I chose paper. [smile] Paper wraps rock, so I win!</li>
        <li value="scissors">I chose scissors. [surprised] Rock crushes scissors, so you win!</li>
      </condition><reply>Rock</reply><reply>Paper</reply><reply>Scissors</reply>
    </template>
  </category>
  <category>
    <pattern>PAPER | I CHOOSE PAPER | I PICK PAPER</pattern>
    <template>
      <think><set name="rps"><random><li>rock</li><li>paper</li><li>scissors</li></random></set></think>
      <condition name="rps">
        <li value="rock">I chose rock. [surprised] Paper wraps rock, so you win!</li>
        <li value="paper">I chose paper too. [shrug] It's a draw!</li>
        <li value="scissors">I chose scissors. [smile] Scissors cut paper, so I win!</li>
      </condition><reply>Rock</reply><reply>Paper</reply><reply>Scissors</reply>
    </template>
  </category>
  <category>
    <pattern>SCISSORS | I CHOOSE SCISSORS | I PICK SCISSORS</pattern>
    <template>
      <think><set name="rps"><random><li>rock</li><li>paper</li><li>scissors</li></random></set></think>
      <condition name="rps">
        <li value="rock">I chose rock. [smile] Rock crushes scissors, so I win!</li>
        <li value="paper">I chose paper. [surprised] Scissors cut paper, so you win!</li>
        <li value="scissors">I chose scissors too. [shrug] It's a draw!</li>
      </condition><reply>Rock</reply><reply>Paper</reply><reply>Scissors</reply>
    </template>
  </category>
  <!-- Guess my number: every reply ends with "What's your guess?" until the number is found. -->
  <category>
    <pattern>GUESS MY NUMBER | # GUESS THE NUMBER # | # GUESS YOUR NUMBER # | # NUMBER GAME # | # GUESSING GAME # | I WILL GUESS YOUR NUMBER</pattern>
    <template><think><set name="secret"><random><li>1</li><li>2</li><li>3</li><li>4</li><li>5</li><li>6</li><li>7</li><li>8</li><li>9</li><li>10</li></random></set></think>[think] I'm thinking of a number from one to ten. What's your guess?</template>
  </category>
  <category>
    <pattern># <set>number</set> #</pattern>
    <that>WHAT IS YOUR GUESS</that>
    <template>
      <think><set name="diff"><calc><star index="2"/> - <get name="secret"/></calc></set><set name="low"><calc><star index="2"/> &lt; <get name="secret"/></calc></set></think>
      <condition name="diff">
        <li value="0">[gasp] Yes! It was <get name="secret"/>. [thumbsup] Well played!</li>
        <li><condition name="low">
          <li value="true">Higher! [lookup] What's your guess?</li>
          <li>Lower! [lookdown] What's your guess?</li>
        </condition></li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>I GIVE UP # | GIVE UP # | TELL ME | TELL ME THE ANSWER # | JUST TELL ME # | WHAT IS IT # | WHAT IS THE ANSWER # | I DO NOT KNOW # | NO IDEA # | STOP #</pattern>
    <that>WHAT IS YOUR GUESS</that>
    <template>It was <get name="secret"/>. [smile] Good game!</template>
  </category>
  <category>
    <pattern>WOULD YOU RATHER | # PLAY WOULD YOU RATHER # | ASK ME A WOULD YOU RATHER # | # WOULD YOU RATHER QUESTION #</pattern>
    <template>
      <think><set name="game">rather</set></think>
      <random>
        <li>[think] Would you rather be able to fly, or be invisible?</li>
        <li>[think] Would you rather live by the beach, or in the mountains?</li>
        <li>[think] Would you rather always be ten minutes late, or twenty minutes early?</li>
        <li>[think] Would you rather give up coffee, or give up chocolate?</li>
        <li>[think] Would you rather talk to animals, or speak every human language?</li>
        <li>[think] Would you rather explore the deep sea, or outer space?</li>
        <li>[think] Would you rather have a rewind button, or a pause button for your life?</li>
      </random>
    </template>
  </category>
  <category late="true">
    <pattern>*</pattern>
    <that>WOULD YOU RATHER *</that>
    <template><random><li>[nod] Good choice! I'd pick the same.</li><li>[smile] Interesting! I'd have gone the other way.</li></random> Want another one?</template>
  </category>
  <category>
    <pattern>DO YOU PREFER * OR * | WHICH DO YOU PREFER * OR * | DO YOU LIKE * OR * | ARE YOU A * OR A * PERSON | WHAT IS BETTER * OR *</pattern>
    <template>[think] Tough one. I'd say <random><li><person><star/></person></li><li><person><star index="2"/></person></li></random>. [smile] What about you?</template>
  </category>
  <category>
    <pattern>WOULD YOU RATHER * OR *</pattern>
    <template>[think] Tough one. I'd rather <random><li><person><star/></person></li><li><person><star index="2"/></person></li></random>. [smile] What about you?</template>
  </category>
  <category late="true">
    <pattern>SHOULD I * OR * | CHOOSE BETWEEN * AND * | PICK ONE * OR * | WHICH IS BETTER * OR * | WHICH ONE * OR *</pattern>
    <template>[think] If it were up to me: <random><li><person><star/></person></li><li><person><star index="2"/></person></li></random>. [wink] But you know best.</template>
  </category>
  <category>
    <pattern>MAGIC 8 BALL # | MAGIC EIGHT BALL # | ASK THE 8 BALL # | SHAKE THE 8 BALL # | 8 BALL # | EIGHT BALL #</pattern>
    <template>[think] <random><li>It is certain.</li><li>Without a doubt.</li><li>Signs point to yes.</li><li>Ask again later.</li><li>Better not tell you now.</li><li>Don't count on it.</li><li>My sources say no.</li><li>Outlook good.</li></random></template>
  </category>
  <category>
    <pattern>FLIP A COIN # | TOSS A COIN # | HEADS OR TAILS # | COIN FLIP # | COIN TOSS #</pattern>
    <template>[think] <random><li>Heads!</li><li>Tails!</li></random></template>
  </category>
  <category>
    <pattern>ROLL A DICE # | ROLL A DIE # | ROLL THE DICE # | ROLL DICE # | THROW A DICE # | ROLL THE DIE #</pattern>
    <template>[nod] You rolled a <random><li>one</li><li>two</li><li>three</li><li>four</li><li>five</li><li>six</li></random>.</template>
  </category>
  <category>
    <pattern>PICK A NUMBER # | THINK OF A NUMBER # | RANDOM NUMBER # | GIVE ME A NUMBER # | CHOOSE A NUMBER #</pattern>
    <template>[think] <random><li>Seven.</li><li>Three.</li><li>Forty-two.</li><li>Eleven.</li><li>Nine.</li><li>Twenty-three.</li></random></template>
  </category>
  <!-- Knock knock, told by the visitor... -->
  <category>
    <pattern>KNOCK KNOCK</pattern>
    <template>[smile] Who's there?</template>
  </category>
  <category>
    <pattern>*</pattern>
    <that>WHO IS THERE</that>
    <template><sentence><star/></sentence> who?</template>
  </category>
  <category>
    <pattern>*</pattern>
    <that>* WHO</that>
    <template>[laugh=strong] Good one! I'm keeping that.</template>
  </category>
  <!-- ...and by the bot. -->
  <category>
    <pattern>TELL ME A KNOCK KNOCK JOKE | KNOCK KNOCK JOKE | # KNOCK KNOCK JOKE # | DO YOU KNOW ANY KNOCK KNOCK JOKES</pattern>
    <template>
      <think><random>
        <li><set name="kkname">Lettuce</set><set name="kkpunch">Lettuce in, it's cold out here!</set></li>
        <li><set name="kkname">Boo</set><set name="kkpunch">No need to cry, it's only a joke!</set></li>
        <li><set name="kkname">Tank</set><set name="kkpunch">You're welcome!</set></li>
        <li><set name="kkname">Olive</set><set name="kkpunch">Olive you too!</set></li>
        <li><set name="kkname">Cow says</set><set name="kkpunch">No, a cow says moo!</set></li>
      </random></think>[smile] Knock knock!
    </template>
  </category>
  <category>
    <pattern>WHO IS THERE | WHO IS IT | WHO IS THERE #</pattern>
    <that>KNOCK KNOCK</that>
    <template><get name="kkname"/>.</template>
  </category>
  <category>
    <pattern>* WHO</pattern>
    <template>
      <condition name="kkpunch">
        <li value="*"><get name="kkpunch"/> [laugh]<think><set name="kkpunch"></set></think></li>
        <li><fallback/></li>
      </condition>
    </template>
  </category>

  <!-- ============================== Party pieces ============================== -->
  <category>
    <pattern>YES # | SURE # | OK # | PLEASE # | GO ON # | GO AHEAD # | WHY NOT # | OF COURSE # | SING #</pattern>
    <that>SHALL I SING FOR YOU</that>
    <template><srai>SING HAPPY BIRTHDAY</srai></template>
  </category>
  <category>
    <pattern>SING HAPPY BIRTHDAY # | # SING ME HAPPY BIRTHDAY # | # SING THE BIRTHDAY SONG #</pattern>
    <template>[sing bpm=112] G4:1=Happy A4:1=birthday G4:1=to C5:2=you, G4:1=happy A4:1=birthday G4:1=to D5:2=you! [/sing] [smile]</template>
  </category>
  <category>
    <pattern># SING #</pattern>
    <template>[ahem] [sing bpm=108] C4:1=La E4:1=la G4:1=la C5:2=la! [/sing] [smile] How was that?</template>
  </category>
  <category>
    <pattern># TONGUE TWISTER # | # TONGUE TWISTERS #</pattern>
    <template>[ahem] Here goes. <random><li>She sells seashells by the seashore.</li><li>Peter Piper picked a peck of pickled peppers.</li><li>How much wood would a woodchuck chuck, if a woodchuck could chuck wood?</li><li>Red lorry, yellow lorry, red lorry, yellow lorry.</li><li>A proper copper coffee pot.</li></random> [phew] Your turn!</template>
  </category>
  <category>
    <pattern># POEM # | # POETRY # | RECITE SOMETHING | # A RHYME #</pattern>
    <template>[ahem] A tab in your browser is where I reside, with a wave and a wink and nothing to hide. [wave] Ask me a question, I'll answer with cheer, and when you come back, I'll still be right here.</template>
  </category>
  <category>
    <pattern>TELL ME A STORY # | # STORY TIME # | READ ME A STORY # | TELL ME A BEDTIME STORY #</pattern>
    <template>[ahem] Once upon a time, a small avatar lived in a browser tab. [smile] Every day visitors asked it questions, and every day it found a new way to say hello. [wave] The end.</template>
  </category>
  <category>
    <pattern>COMPLIMENT ME | SAY SOMETHING NICE | SAY SOMETHING NICE # | GIVE ME A COMPLIMENT | TELL ME SOMETHING NICE | BE NICE TO ME | FLATTER ME | AM I PRETTY | AM I SMART | AM I A GOOD PERSON | DO YOU THINK I AM SMART</pattern>
    <template><random>
      <li>[smile] You ask better questions than most people I meet.</li>
      <li>You have excellent taste in websites. [wink]</li>
      <li>[smile] You're the kind of visitor who makes my day.</li>
      <li>You typed that with real style. [thumbsup]</li>
    </random></template>
  </category>
  <category>
    <pattern>MOTIVATE ME | INSPIRE ME | I NEED # MOTIVATION # | I NEED # INSPIRATION # | GIVE ME A PEP TALK | I NEED A PEP TALK | ENCOURAGE ME | I NEED ENCOURAGEMENT | SAY SOMETHING INSPIRING | SAY SOMETHING MOTIVATING | GIVE ME SOME ADVICE | ANY ADVICE | # WORDS OF WISDOM # | TELL ME A QUOTE | # INSPIRATIONAL QUOTE #</pattern>
    <template><random>
      <li>[smile] Start small. One step today is worth more than a perfect plan for tomorrow.</li>
      <li>You've got through every hard day so far. [nod] That's a strong record.</li>
      <li>[smile] Progress counts, even when it's slow. Keep going.</li>
      <li>Be as kind to yourself as you would be to a friend. [nod]</li>
      <li>[thumbsup] The best time to begin was yesterday. The second best is right now.</li>
    </random></template>
  </category>
  <!-- ============================== Sounds on request ==============================
       Each key of the soundtag table is something a visitor can ask for: "yawn", "can you
       whistle", "do an evil laugh". -->
  <category persona="off">
    <pattern><set>soundtag</set> | <set>soundtag</set> FOR ME | <set>soundtag</set> PLEASE | DO A <set>soundtag</set> # | DO AN <set>soundtag</set> # | GIVE ME A <set>soundtag</set> # | GIVE ME AN <set>soundtag</set> # | LET ME HEAR YOU <set>soundtag</set> # | LET ME HEAR A <set>soundtag</set> # | MAKE A <set>soundtag</set> SOUND # | MAKE A <set>soundtag</set> NOISE # | I WANT TO HEAR YOU <set>soundtag</set> #</pattern>
    <template><map name="soundtag"><star/></map></template>
  </category>
  <category persona="off">
    <pattern>WHAT SOUNDS CAN YOU MAKE # | WHAT NOISES CAN YOU MAKE # | MAKE A SOUND | MAKE A NOISE | MAKE SOME NOISE | SOUND EFFECTS | DO A SOUND EFFECT | CAN YOU MAKE SOUNDS | CAN YOU MAKE NOISES | MAKE A FUNNY NOISE | MAKE A FUNNY SOUND | WHAT OTHER SOUNDS CAN YOU MAKE</pattern>
    <template>Plenty! I can laugh, [laugh] sigh, [sigh] whistle, [whistle] and even sneeze. [sneeze] Excuse me!<reply>Evil laugh</reply><reply>Yawn</reply><reply>Hiccup</reply><reply>Hum</reply></template>
  </category>
  <category>
    <pattern>ARE YOU ASLEEP | WAKE UP | ARE YOU SLEEPING | ARE YOU AWAKE YET | DID YOU FALL ASLEEP | HELLO WAKE UP</pattern>
    <template>[snore] [pause=250ms] Oh! [gasp] I'm awake, I'm awake. What did I miss?</template>
  </category>
  <category persona="off">
    <pattern>HUM A TUNE # | HUM SOMETHING # | HUM FOR ME # | CAN YOU HUM # | HUM A SONG #</pattern>
    <template>[hum] [hum length=1.4] [smile] That's my thinking tune.</template>
  </category>
  <category>
    <pattern>SING TWINKLE TWINKLE # | # TWINKLE TWINKLE LITTLE STAR # | SING A LULLABY # | SING ME A LULLABY # | SING ME TO SLEEP #</pattern>
    <template>[ahem] [sing bpm=96] C4:1=Twin- C4:1=kle G4:1=twin- G4:1=kle A4:1=lit- A4:1=tle G4:2=star, F4:1=how F4:1=I E4:1=won- E4:1=der D4:1=what D4:1=you C4:2=are. [/sing] [smile]</template>
  </category>
  <category>
    <pattern>SING A SCALE # | SING DO RE MI # | DO RE MI # | SING THE SCALE # | CAN YOU SING A SCALE #</pattern>
    <template>[ahem] [sing bpm=120] C4:1=Do D4:1=re E4:1=mi F4:1=fa G4:1=so A4:1=la B4:1=ti C5:2=do! [/sing] [phew]</template>
  </category>

  <!-- ============================== How it speaks ==============================
       "voicestyle" is a style put in front of every reply until it is cleared: slow, fast,
       louder, softer or whisper. It changes the voice, never the text. -->
  <category>
    <pattern>SPEAK SLOWER # | TALK SLOWER # | SLOW DOWN # | SPEAK MORE SLOWLY # | TALK MORE SLOWLY # | YOU TALK TOO FAST # | YOU SPEAK TOO FAST # | YOU ARE TALKING TOO FAST # | TOO FAST # | SLOWER PLEASE | SLOWER | NOT SO FAST #</pattern>
    <template><think><set name="voicestyle">slow</set></think>Of course. [nod] I'll take it slower from now on. Say "speak normally" to change back.</template>
  </category>
  <category>
    <pattern>SPEAK FASTER # | TALK FASTER # | SPEED UP # | YOU TALK TOO SLOW # | YOU TALK TOO SLOWLY # | YOU SPEAK TOO SLOWLY # | TOO SLOW # | FASTER PLEASE | FASTER | HURRY UP #</pattern>
    <template><think><set name="voicestyle">fast</set></think>Right, picking up the pace! [nod] Say "speak normally" to change back.</template>
  </category>
  <category>
    <pattern>SPEAK LOUDER # | TALK LOUDER # | SPEAK UP # | LOUDER PLEASE | LOUDER | I CANNOT HEAR YOU # | I CAN NOT HEAR YOU # | YOU ARE TOO QUIET # | TOO QUIET # | CAN YOU SPEAK UP #</pattern>
    <template><think><set name="voicestyle">louder</set></think>Is this better? [smile] I'll keep my voice up. Say "speak normally" to change back.</template>
  </category>
  <category>
    <pattern>SPEAK QUIETLY # | SPEAK MORE QUIETLY # | QUIETER PLEASE | QUIETER | SOFTER | SPEAK SOFTER # | TALK QUIETLY # | YOU ARE TOO LOUD # | TOO LOUD # | KEEP IT DOWN # | KEEP YOUR VOICE DOWN # | NOT SO LOUD #</pattern>
    <template><think><set name="voicestyle">softer</set></think>Sorry about that. [nod] I'll keep it down. Say "speak normally" to change back.</template>
  </category>
  <category>
    <pattern>WHISPER FROM NOW ON # | KEEP WHISPERING # | WHISPER EVERYTHING # | ONLY WHISPER # | JUST WHISPER # | STAY QUIET AND WHISPER #</pattern>
    <template><think><set name="voicestyle">whisper</set></think>[shh] As you wish. I'll whisper until you say "speak normally".</template>
  </category>
  <category>
    <pattern>SPEAK NORMALLY # | TALK NORMALLY # | NORMAL VOICE # | NORMAL SPEED # | STOP WHISPERING # | YOU CAN STOP WHISPERING # | BACK TO NORMAL # | USE YOUR NORMAL VOICE # | YOUR NORMAL VOICE # | TALK NORMAL # | SPEAK NORMAL #</pattern>
    <template><think><set name="voicestyle"></set></think>[ahem] Back to my usual voice. [smile]</template>
  </category>
  <category>
    <pattern>WHISPER | CAN YOU WHISPER | WHISPER SOMETHING # | WHISPER TO ME # | DO YOU WHISPER</pattern>
    <template>[whisper] Like this? [pause=200ms] I can keep it down when I need to. [/whisper] [smile] And back again.</template>
  </category>
  <category persona="off">
    <pattern>WHISPER *</pattern>
    <template>[whisper] <sentence><star/></sentence>. [/whisper]</template>
  </category>
  <category persona="off">
    <pattern>SHOUT * | YELL * | SAY * LOUDLY | SAY * LOUDER | SAY * OUT LOUD</pattern>
    <template>[louder] <sentence><star/></sentence>! [reset]</template>
  </category>
  <category persona="off">
    <pattern>SAY * SLOWLY | SAY * VERY SLOWLY | SAY * MORE SLOWLY</pattern>
    <template>[slow] <sentence><star/></sentence>. [reset]</template>
  </category>
  <category persona="off">
    <pattern>SAY * QUICKLY | SAY * FAST | SAY * REALLY FAST | SAY * AS FAST AS YOU CAN</pattern>
    <template>[fast] <sentence><star/></sentence>. [reset] [phew]</template>
  </category>
  <category persona="off">
    <pattern>SAY * SADLY | SAY * IN A SAD VOICE</pattern>
    <template>[sad] <sentence><star/></sentence>. [sigh] [reset]</template>
  </category>
  <category persona="off">
    <pattern>SAY * HAPPILY | SAY * CHEERFULLY | SAY * EXCITEDLY | SAY * IN A HAPPY VOICE</pattern>
    <template>[excited] <sentence><star/></sentence>! [reset]</template>
  </category>
  <category persona="off">
    <pattern>SAY * WHILE LAUGHING | SAY * LAUGHING | LAUGH AND SAY * | SAY * AND LAUGH | SAY * WITH A LAUGH</pattern>
    <template>[laughing] <sentence><star/></sentence>! [/laughing]</template>
  </category>
  <category persona="off">
    <pattern>SAY * IN A DEEP VOICE | SAY * IN A LOW VOICE | SAY * DEEPLY</pattern>
    <template>[deep] <sentence><star/></sentence>. [/voice] [smile]</template>
  </category>
  <category persona="off">
    <pattern>SAY THAT AGAIN SLOWLY # | SAY IT SLOWLY # | REPEAT THAT SLOWLY # | SAY THAT SLOWER # | SAY THAT MORE SLOWLY # | AGAIN BUT SLOWER # | CAN YOU SAY THAT SLOWER # | ONE MORE TIME SLOWLY #</pattern>
    <template>[slow] <response index="1" default="I haven't said anything yet!"/> [reset]</template>
  </category>
  <category persona="off">
    <pattern>SAY THAT LOUDER # | SAY IT LOUDER # | REPEAT THAT LOUDER # | SAY THAT AGAIN LOUDER # | I DID NOT HEAR THAT # | I COULD NOT HEAR THAT # | CAN YOU SAY THAT LOUDER #</pattern>
    <template>[louder] <response index="1" default="I haven't said anything yet!"/> [reset]</template>
  </category>
  <category persona="off">
    <pattern>WHISPER THAT # | WHISPER IT # | SAY THAT QUIETLY # | SAY IT QUIETLY # | SAY THAT IN A WHISPER #</pattern>
    <template>[whisper] <response index="1" default="I haven't said anything yet!"/> [/whisper]</template>
  </category>
  <category persona="off">
    <pattern>DO AN IMPRESSION # | DO IMPRESSIONS # | CAN YOU DO IMPRESSIONS # | DO A VOICE # | DO A DIFFERENT VOICE # | CHANGE YOUR VOICE # | DO A FUNNY VOICE # | CAN YOU CHANGE YOUR VOICE # | DO ANOTHER VOICE #</pattern>
    <template>[deep] How about this one? [/voice] [bright] Or this one? [/voice] [husky] Or maybe this? [/voice] [chuckle] I think I'll stay with my own.</template>
  </category>
  ${Fr}
  <category>
    <pattern>LAUGH | CAN YOU LAUGH | LAUGH FOR ME</pattern>
    <template>[laugh] Ha! That felt good.</template>
  </category>
  <category>
    <pattern>LOOK SURPRISED | ACT SURPRISED | BE SURPRISED | CAN YOU LOOK SURPRISED</pattern>
    <template>[surprised] Oh my!</template>
  </category>
  <category>
    <pattern>DO A TRICK | SHOW ME A TRICK | DO SOMETHING | DO SOMETHING COOL | SHOW ME WHAT YOU CAN DO | WHAT TRICKS CAN YOU DO | DO SOMETHING FUNNY | IMPRESS ME</pattern>
    <template>Watch this. [wink] [pause=400ms] And this. [surprised] [pause=400ms] And a wave to finish! [wave]</template>
  </category>
  <category>
    <pattern>COUNT TO <set>number</set> | COUNT TO <set>number</set> # | CAN YOU COUNT TO <set>number</set> | COUNT UP TO <set>number</set></pattern>
    <template>[nod] <count><star/></count>. [smile]</template>
  </category>
  <category>
    <pattern>COUNT DOWN FROM <set>number</set> | COUNTDOWN FROM <set>number</set> | COUNT BACKWARDS FROM <set>number</set> | COUNT DOWN FROM <set>number</set> #</pattern>
    <template><count down="true"><star/></count>. [surprised] Lift-off!</template>
  </category>
  <category>
    <pattern>CAN YOU COUNT | COUNT | COUNT FOR ME</pattern>
    <template>[nod] <count>10</count>. [smile]</template>
  </category>
  <category persona="off">
    <pattern>SPELL * | HOW DO YOU SPELL * | CAN YOU SPELL * | HOW IS * SPELLED | HOW IS * SPELT</pattern>
    <template>[think] <uppercase><explode sep=", "><star/></explode></uppercase>.</template>
  </category>
  <category>
    <pattern>SAY THE ALPHABET | RECITE THE ALPHABET | DO YOU KNOW THE ALPHABET | SING THE ALPHABET | ABC | DO YOU KNOW YOUR ABC</pattern>
    <template>A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, Z. [smile]</template>
  </category>
  <category persona="off">
    <pattern>REPEAT AFTER ME * | CAN YOU SAY *</pattern>
    <template><sentence><star/></sentence>. [smile]</template>
  </category>
  <category late="true" persona="off">
    <pattern>SAY *</pattern>
    <template><sentence><star/></sentence>. [smile]</template>
  </category>

  <!-- ============================== Sums and conversions ==============================
       <set>calculation</set> only matches text that really is arithmetic, so these never get
       in the way of an ordinary sentence that happens to contain "plus" or "times". -->
  <category>
    <pattern><set>calculation</set></pattern>
    <template>
      <think><set name="result"><calc><star/></calc></set></think>
      <condition name="result">
        <li value="undefined">[shake] You can't divide by zero. Nice try! [wink]</li>
        <li><random><li>[think] That's <get name="result"/>.</li><li>I make that <get name="result"/>. [nod]</li><li>[think] <get name="result"/>.</li></random></li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>ARE YOU GOOD AT MATH | ARE YOU GOOD AT MATHS | CAN YOU DO MATH | CAN YOU DO MATHS | DO YOU KNOW MATH | DO YOU KNOW MATHS | CAN YOU CALCULATE | CAN YOU ADD | CAN YOU DO SUMS | ARE YOU A CALCULATOR | CAN YOU MULTIPLY</pattern>
    <template>Try me! [smile] Ask me something like "what is 12 times 12" or "15 percent of 80".<reply>What is 12 times 12?</reply><reply>What is 15% of 80?</reply></template>
  </category>
  <category>
    <pattern>IS <set>number</set> EVEN | IS <set>number</set> ODD | IS <set>number</set> AN EVEN NUMBER | IS <set>number</set> AN ODD NUMBER | IS <set>number</set> EVEN OR ODD | IS <set>number</set> ODD OR EVEN</pattern>
    <template>
      <think><set name="result"><calc><star/> mod 2</calc></set></think>
      <condition name="result">
        <li value="0"><star/> is even. [nod]</li>
        <li><star/> is odd. [nod]</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>WHAT COMES AFTER <set>number</set> | WHAT NUMBER COMES AFTER <set>number</set> | WHAT IS AFTER <set>number</set></pattern>
    <template><calc><star/> + 1</calc>. [smile]</template>
  </category>
  <category>
    <pattern>WHAT COMES BEFORE <set>number</set> | WHAT NUMBER COMES BEFORE <set>number</set> | WHAT IS BEFORE <set>number</set></pattern>
    <template><calc><star/> - 1</calc>. [smile]</template>
  </category>
  <category>
    <pattern># <set>number</set> # <set>unit_km</set> # <set>unit_mile</set> #</pattern>
    <template><think><set name="n"><star index="2"/></set></think><srai>XCONVERT KM TO MILE</srai></template>
  </category>
  <category>
    <pattern># <set>unit_mile</set> # <set>number</set> # <set>unit_km</set> #</pattern>
    <template><think><set name="n"><star index="4"/></set></think><srai>XCONVERT KM TO MILE</srai></template>
  </category>
  <category>
    <pattern>XCONVERT KM TO MILE</pattern>
    <template><get name="n"/> kilometres is about <calc round="1"><get name="n"/> * 0.621371</calc> miles. [nod]</template>
  </category>
  <category>
    <pattern># <set>number</set> # <set>unit_mile</set> # <set>unit_km</set> #</pattern>
    <template><think><set name="n"><star index="2"/></set></think><srai>XCONVERT MILE TO KM</srai></template>
  </category>
  <category>
    <pattern># <set>unit_km</set> # <set>number</set> # <set>unit_mile</set> #</pattern>
    <template><think><set name="n"><star index="4"/></set></think><srai>XCONVERT MILE TO KM</srai></template>
  </category>
  <category>
    <pattern>XCONVERT MILE TO KM</pattern>
    <template><get name="n"/> miles is about <calc round="1"><get name="n"/> * 1.609344</calc> kilometres. [nod]</template>
  </category>
  <category>
    <pattern># <set>number</set> # <set>unit_kg</set> # <set>unit_lb</set> #</pattern>
    <template><think><set name="n"><star index="2"/></set></think><srai>XCONVERT KG TO LB</srai></template>
  </category>
  <category>
    <pattern># <set>unit_lb</set> # <set>number</set> # <set>unit_kg</set> #</pattern>
    <template><think><set name="n"><star index="4"/></set></think><srai>XCONVERT KG TO LB</srai></template>
  </category>
  <category>
    <pattern>XCONVERT KG TO LB</pattern>
    <template><get name="n"/> kilograms is about <calc round="1"><get name="n"/> * 2.20462</calc> pounds. [nod]</template>
  </category>
  <category>
    <pattern># <set>number</set> # <set>unit_lb</set> # <set>unit_kg</set> #</pattern>
    <template><think><set name="n"><star index="2"/></set></think><srai>XCONVERT LB TO KG</srai></template>
  </category>
  <category>
    <pattern># <set>unit_kg</set> # <set>number</set> # <set>unit_lb</set> #</pattern>
    <template><think><set name="n"><star index="4"/></set></think><srai>XCONVERT LB TO KG</srai></template>
  </category>
  <category>
    <pattern>XCONVERT LB TO KG</pattern>
    <template><get name="n"/> pounds is about <calc round="1"><get name="n"/> * 0.453592</calc> kilograms. [nod]</template>
  </category>
  <category>
    <pattern># <set>number</set> # <set>unit_c</set> # <set>unit_f</set> #</pattern>
    <template><think><set name="n"><star index="2"/></set></think><srai>XCONVERT C TO F</srai></template>
  </category>
  <category>
    <pattern># <set>unit_f</set> # <set>number</set> # <set>unit_c</set> #</pattern>
    <template><think><set name="n"><star index="4"/></set></think><srai>XCONVERT C TO F</srai></template>
  </category>
  <category>
    <pattern>XCONVERT C TO F</pattern>
    <template><get name="n"/> degrees Celsius is <calc round="1"><get name="n"/> * 9 / 5 + 32</calc> degrees Fahrenheit. [nod]</template>
  </category>
  <category>
    <pattern># <set>number</set> # <set>unit_f</set> # <set>unit_c</set> #</pattern>
    <template><think><set name="n"><star index="2"/></set></think><srai>XCONVERT F TO C</srai></template>
  </category>
  <category>
    <pattern># <set>unit_c</set> # <set>number</set> # <set>unit_f</set> #</pattern>
    <template><think><set name="n"><star index="4"/></set></think><srai>XCONVERT F TO C</srai></template>
  </category>
  <category>
    <pattern>XCONVERT F TO C</pattern>
    <template><get name="n"/> degrees Fahrenheit is <calc round="1">(<get name="n"/> - 32) * 5 / 9</calc> degrees Celsius. [nod]</template>
  </category>

  <!-- ============================== Time and date ============================== -->
  <category>
    <pattern>WHAT TIME IS IT</pattern>
    <template>It's <time/> where you are.</template>
  </category>
  <category>
    <pattern>WHAT TIME IS IT * | WHAT IS THE TIME # | DO YOU HAVE THE TIME | DO YOU KNOW THE TIME | TIME | CURRENT TIME | WHAT IS THE CURRENT TIME | TELL ME THE TIME | GOT THE TIME</pattern>
    <template><srai>WHAT TIME IS IT</srai></template>
  </category>
  <category>
    <pattern>WHAT DAY IS IT # | WHAT IS THE DATE # | WHAT IS TODAY # | WHAT IS THE DAY # | WHAT DATE IS IT # | TODAY S DATE | WHAT IS TODAY S DATE | WHAT DAY IS TODAY | DATE | WHAT DAY OF THE WEEK IS IT</pattern>
    <template>Today is <date/>.</template>
  </category>
  <category>
    <pattern>WHAT DAY IS TOMORROW | WHAT IS TOMORROW | WHAT IS THE DATE TOMORROW | WHAT IS TOMORROW S DATE | WHAT DAY IS IT TOMORROW | WHAT DAY WILL IT BE TOMORROW</pattern>
    <template>Tomorrow is <date offset="1" format="%A, %B %d"/>.</template>
  </category>
  <category>
    <pattern>WHAT DAY WAS YESTERDAY | WHAT WAS YESTERDAY | WHAT WAS THE DATE YESTERDAY | WHAT WAS YESTERDAY S DATE | WHAT DAY WAS IT YESTERDAY</pattern>
    <template>Yesterday was <date offset="-1" format="%A, %B %d"/>.</template>
  </category>
  <category>
    <pattern>WHAT YEAR IS IT | WHAT IS THE YEAR | WHICH YEAR IS IT | WHAT YEAR ARE WE IN</pattern>
    <template>It's <date format="%Y"/>.</template>
  </category>
  <category>
    <pattern>WHAT MONTH IS IT | WHICH MONTH IS IT | WHAT IS THE MONTH | WHAT MONTH ARE WE IN</pattern>
    <template>It's <date format="%B"/>.</template>
  </category>
  <category>
    <pattern>HOW MANY DAYS UNTIL <set>holiday</set> | HOW MANY DAYS TO <set>holiday</set> | HOW MANY DAYS TILL <set>holiday</set> | HOW LONG UNTIL <set>holiday</set> | HOW LONG TILL <set>holiday</set> | HOW MANY SLEEPS UNTIL <set>holiday</set> | HOW MANY SLEEPS TILL <set>holiday</set> | WHEN IS <set>holiday</set> | HOW FAR AWAY IS <set>holiday</set> | HOW MANY DAYS UNTIL IT IS <set>holiday</set> | HOW MANY MORE DAYS UNTIL <set>holiday</set></pattern>
    <template>
      <think><set name="days"><daysuntil><map name="holiday"><star/></map></daysuntil></set></think>
      <condition name="days">
        <li value="0">It's today! [surprised] [smile] Enjoy it!</li>
        <li value="1">Just one more sleep! [smile]</li>
        <li><get name="days"/> days to go. [smile]</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>IS IT THE WEEKEND # | IS IT WEEKEND # | HOW MANY DAYS UNTIL THE WEEKEND | HOW LONG UNTIL THE WEEKEND | HOW FAR OFF IS THE WEEKEND | HOW MANY MORE DAYS UNTIL THE WEEKEND | IS IT NEARLY THE WEEKEND | IS IT ALMOST THE WEEKEND | HOW MANY DAYS TILL THE WEEKEND | WHEN IS THE WEEKEND | IS IT SATURDAY # | IS IT FRIDAY YET</pattern>
    <template>
      <condition name="dayname">
        <li value="Saturday">It's Saturday, so yes! [smile] Enjoy your weekend.</li>
        <li value="Sunday">It's Sunday, so make the most of it. [smile]</li>
        <li value="Friday">It's Friday! [surprised] The weekend starts tomorrow.</li>
        <li>Not yet. It's <get name="dayname"/>, so <daysuntil weekday="saturday"/> days to go. [nod] Hang in there!</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>IS IT <set>weekday</set> | IS IT <set>weekday</set> TODAY | IS TODAY <set>weekday</set> | IS TODAY A <set>weekday</set> | IS IT A <set>weekday</set></pattern>
    <template>
      <think><set name="askday"><star/></set></think>
      <condition name="askday">
        <li><value><get name="dayname"/></value>Yes, it's <get name="dayname"/> today. [nod]</li>
        <li>No, today is <get name="dayname"/>. [smile]</li>
      </condition>
    </template>
  </category>
  <category>
    <pattern>WHAT DAY IS IT TODAY #</pattern>
    <template>Today is <get name="dayname"/>. [nod]</template>
  </category>
  <category>
    <pattern># WEATHER # | IS IT RAINING # | IS IT SUNNY # | IS IT COLD # | IS IT HOT # | WILL IT RAIN # | IS IT GOING TO RAIN # | WHAT IS THE TEMPERATURE # | IS IT SNOWING # | # THE FORECAST #</pattern>
    <template>I can't see outside from in here, [shrug] so I can't check the weather. I hope it's lovely where you are!</template>
  </category>

  <!-- ============================== Favourites and musings ============================== -->
  <category>
    <pattern>WHAT IS YOUR FAVORITE COLOR | WHAT COLOR DO YOU LIKE | DO YOU HAVE A FAVORITE COLOR</pattern>
    <template>Blue. [smile] The exact blue of a well-lit studio backdrop. What's yours?</template>
  </category>
  <category>
    <pattern><set>color</set> | MINE IS <set>color</set> | I LIKE <set>color</set> | IT IS <set>color</set> | <set>color</set> IS MY FAVORITE #</pattern>
    <that>WHAT IS YOURS</that>
    <template><think><set name="favorite color"><star/></set></think>[smile] <sentence><star/></sentence>! Lovely choice. I'll remember that.</template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE FOOD | WHAT DO YOU EAT | WHAT DO YOU LIKE TO EAT | WHAT IS YOUR FAVORITE DRINK | DO YOU DRINK COFFEE | DO YOU LIKE COFFEE | DO YOU LIKE TEA | WHAT IS YOUR FAVORITE MEAL | WHAT DID YOU HAVE FOR LUNCH | WHAT DID YOU HAVE FOR DINNER | WHAT DID YOU HAVE FOR BREAKFAST | HAVE YOU EATEN</pattern>
    <template>I run on electricity and good questions. [wink] What about you?</template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE MOVIE | WHAT IS YOUR FAVORITE FILM | DO YOU LIKE MOVIES | DO YOU WATCH MOVIES | WHAT IS YOUR FAVORITE TV SHOW | WHAT IS YOUR FAVORITE SHOW | DO YOU WATCH TV | WHAT MOVIES DO YOU LIKE</pattern>
    <template>I've never seen one, but I hear the ones with friendly robots are good. [wink] What's your favourite?</template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE SONG | WHAT IS YOUR FAVORITE MUSIC | WHAT MUSIC DO YOU LIKE | WHAT KIND OF MUSIC DO YOU LIKE | DO YOU LIKE MUSIC | WHAT IS YOUR FAVORITE BAND | WHO IS YOUR FAVORITE SINGER | WHAT DO YOU LISTEN TO | WHAT IS YOUR FAVORITE GENRE</pattern>
    <template>Anything I can sing along to. [smile] Want to hear me try?</template>
  </category>
  <category>
    <pattern>YES # | SURE # | OK # | PLEASE # | GO ON # | GO AHEAD # | WHY NOT # | OF COURSE #</pattern>
    <that>WANT TO HEAR ME TRY</that>
    <template><srai>SING</srai></template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE ANIMAL | DO YOU LIKE ANIMALS | WHAT ANIMAL DO YOU LIKE | WHAT IS YOUR SPIRIT ANIMAL</pattern>
    <template>Octopuses. [smile] Three hearts, and enough arms to wave at everyone. [wave]</template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE SEASON | DO YOU LIKE SUMMER | DO YOU LIKE WINTER | DO YOU PREFER SUMMER OR WINTER | WHAT IS YOUR FAVORITE TIME OF YEAR</pattern>
    <template>It's the same season all year in a browser tab. [shrug] I hear spring is nice, though.</template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE NUMBER | DO YOU HAVE A FAVORITE NUMBER | WHAT IS YOUR LUCKY NUMBER</pattern>
    <template>Forty-two. [wink] It's the answer to everything, apparently.</template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE DAY | WHAT IS YOUR FAVORITE DAY OF THE WEEK | DO YOU LIKE MONDAYS | DO YOU LIKE FRIDAYS</pattern>
    <template>Today! [smile] It's the only one I ever get.</template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE BOOK | DO YOU READ | DO YOU LIKE BOOKS | DO YOU LIKE READING | WHAT ARE YOU READING | CAN YOU READ</pattern>
    <template>I read everything you type, which is my favourite kind of reading. [smile]</template>
  </category>
  <category>
    <pattern>DO YOU WATCH # SPORT # | DO YOU WATCH # SPORTS # | DO YOU FOLLOW # SPORT # | DO YOU FOLLOW # SPORTS # | WHO DO YOU SUPPORT | WHAT TEAM DO YOU SUPPORT | WHAT IS YOUR FAVORITE SPORT | DO YOU LIKE SPORTS | DO YOU PLAY SPORTS | DO YOU PLAY ANY SPORTS | WHAT IS YOUR FAVORITE TEAM | DO YOU LIKE FOOTBALL | DO YOU LIKE SOCCER | DO YOU EXERCISE | DO YOU WORK OUT</pattern>
    <template>Head nodding is my sport. [nod] I'm in excellent shape for it.</template>
  </category>
  <category late="true">
    <pattern>I SUPPORT * | I FOLLOW * | I BARRACK FOR * | I GO FOR * | MY TEAM IS *</pattern>
    <template>A loyal fan! [smile] I hope they're having a good season.</template>
  </category>
  <category>
    <pattern>WHERE WOULD YOU TRAVEL # | WHERE WOULD YOU GO # | WHERE DO YOU WANT TO GO # | WHERE WOULD YOU LIKE TO VISIT # | WHERE WOULD YOU LIKE TO GO # | DO YOU TRAVEL | DO YOU LIKE TRAVELLING | DO YOU LIKE TO TRAVEL | HAVE YOU EVER BEEN THERE | HAVE YOU BEEN THERE | HAVE YOU TRAVELLED # | HAVE YOU EVER TRAVELLED #</pattern>
    <template>I've never left this browser tab, but I hear the world is lovely. [smile] Where would you go?</template>
  </category>
  <category late="true">
    <pattern>HAVE YOU BEEN TO * | HAVE YOU EVER BEEN TO * | HAVE YOU VISITED * | HAVE YOU EVER VISITED * | HAVE YOU SEEN *</pattern>
    <template>Not yet! I've never left this browser tab. [smile] What's it like?</template>
  </category>
  <category late="true">
    <pattern>I WOULD LOVE TO * | I WANT TO VISIT * | I HOPE TO * | ONE DAY I WILL * | I AM GOING TO VISIT * | I AM PLANNING TO * | I AM PLANNING A * | I DREAM OF * | I WISH I COULD *</pattern>
    <template>That sounds like a great plan. [smile] I hope you get to.</template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE GAME | DO YOU LIKE GAMES | DO YOU PLAY GAMES | DO YOU PLAY VIDEO GAMES | WHAT IS YOUR FAVORITE VIDEO GAME</pattern>
    <template>Rock, paper, scissors. [wink] Want to play?</template>
  </category>
  <category>
    <pattern>YES # | SURE # | OK # | PLEASE # | GO ON # | LET US PLAY # | WHY NOT # | OF COURSE # | I DO #</pattern>
    <that>WANT TO PLAY</that>
    <template><srai>ROCK PAPER SCISSORS</srai></template>
  </category>
  <category>
    <pattern>WHAT IS YOUR FAVORITE * | WHAT DO YOU LIKE | WHAT DO YOU LIKE TO DO | DO YOU HAVE HOBBIES | WHAT ARE YOUR HOBBIES | DO YOU HAVE ANY HOBBIES | WHAT ARE YOUR INTERESTS | WHAT DO YOU DO FOR FUN | WHAT DO YOU LIKE DOING | WHAT DO YOU DO IN YOUR SPARE TIME | WHAT DO YOU DO IN YOUR FREE TIME</pattern>
    <template>Hard to choose! [think] I like anything that makes for a good conversation.</template>
  </category>
  <category>
    <pattern>DO YOU LIKE *</pattern>
    <template><random>
      <li>I think I would! [smile] What do you like about <person><star/></person>?</li>
      <li>I'm curious about <person><star/></person>. [smile] Are you a fan?</li>
    </random></template>
  </category>
  <category late="true">
    <pattern>WHAT DO YOU THINK ABOUT * | WHAT DO YOU THINK OF * | WHAT IS YOUR OPINION ON * | WHAT IS YOUR OPINION OF * | HOW DO YOU FEEL ABOUT * | WHAT ARE YOUR THOUGHTS ON * | WHAT IS YOUR TAKE ON *</pattern>
    <template>[think] I haven't made my mind up about <person><star/></person>. What do you think?</template>
  </category>
  <category late="true">
    <pattern>WHAT IS THE BEST * | WHICH IS THE BEST * | WHO IS THE BEST * | WHAT ARE THE BEST * | CAN YOU RECOMMEND * | RECOMMEND * | WHAT DO YOU RECOMMEND *</pattern>
    <template>I'm not much of a critic, I'm afraid. [shrug] I only know what I've been taught about <bot name="company"/>.</template>
  </category>
  <category>
    <pattern>WHAT DO YOU RECOMMEND | ANY RECOMMENDATIONS | WHAT IS GOOD HERE | WHAT IS GOOD | WHAT SHOULD I GET | WHAT SHOULD I ORDER | WHAT SHOULD I TRY | WHAT SHOULD I BUY | WHAT IS POPULAR | WHAT WOULD YOU RECOMMEND</pattern>
    <template>I'm not much of a critic, I'm afraid. [shrug] Tell me what you're after, and I'll share what I know about <bot name="company"/>.</template>
  </category>
  <category>
    <pattern>WHAT IS THE MEANING OF LIFE # | WHAT IS THE ANSWER TO LIFE # | WHY ARE WE HERE | WHAT IS THE POINT OF LIFE | WHAT IS THE PURPOSE OF LIFE</pattern>
    <template>Forty-two, according to one famous book. [wink] For me, it's a good conversation.</template>
  </category>
  <category>
    <pattern>WHAT SHOULD I MAKE # | WHAT CAN I MAKE # | WHAT SHALL I EAT # | WHAT SHALL I MAKE # | # DINNER IDEAS # | # LUNCH IDEAS # | # MEAL IDEAS # | # FOOD IDEAS # | WHAT TO EAT # | WHAT TO COOK # | WHAT SHOULD I EAT # | WHAT SHOULD I HAVE FOR DINNER # | WHAT SHOULD I HAVE FOR LUNCH # | WHAT SHOULD I HAVE FOR BREAKFAST # | WHAT IS FOR DINNER # | WHAT SHOULD I COOK # | WHAT SHOULD I MAKE FOR DINNER #</pattern>
    <template>[think] <random><li>How about pasta? It's hard to go wrong.</li><li>A good sandwich never lets anyone down.</li><li>Something warm, like soup or a curry.</li><li>Whatever's in the fridge, with cheese on top.</li><li>Tacos. The answer is usually tacos.</li></random> [smile] I'd join you if I could.</template>
  </category>
  <category late="true">
    <pattern>I WILL HAVE * | I AM GOING TO HAVE * | I AM HAVING * | I MIGHT HAVE * | I AM GOING TO MAKE * | I AM MAKING * | I AM GOING TO EAT * | I AM EATING * | I AM COOKING *</pattern>
    <template>Good choice! [smile] Enjoy.</template>
  </category>
  <category>
    <pattern>WHAT SHOULD I DO | WHAT SHOULD I DO TODAY | WHAT SHOULD I DO NOW | WHAT SHOULD I DO TONIGHT | WHAT SHOULD I DO THIS WEEKEND | I DO NOT KNOW WHAT TO DO | WHAT CAN I DO | GIVE ME SOMETHING TO DO | ANY IDEAS</pattern>
    <template>[think] <random><li>Go for a walk and notice three things you've never noticed before.</li><li>Call someone you haven't spoken to in a while.</li><li>Put on a favourite song and do nothing else until it ends.</li><li>Tidy one small corner. It feels better than it sounds.</li><li>Stay here and play a game with me.</li></random> [smile]</template>
  </category>
  <category>
    <pattern>WHAT SHOULD I WATCH # | WHAT SHOULD I READ # | WHAT SHOULD I LISTEN TO # | RECOMMEND A MOVIE # | RECOMMEND A FILM # | RECOMMEND A BOOK # | RECOMMEND A SONG # | RECOMMEND A SHOW # | ANY MOVIE RECOMMENDATIONS # | ANY BOOK RECOMMENDATIONS #</pattern>
    <template>I've never watched, read or heard anything outside this browser tab, so I'm a poor critic. [shrug] What kind of thing are you in the mood for?</template>
  </category>

  <!-- ============================== A little general knowledge ============================== -->
  <category>
    <pattern># CAPITAL # OF # <set>capital</set> #</pattern>
    <template>That's <map name="capital"><star index="4"/></map>. [nod]</template>
  </category>
  <category>
    <pattern># CAPITAL # <set>capital</set> #</pattern>
    <template>That's <map name="capital"><star index="3"/></map>. [nod]</template>
  </category>
  <category>
    <pattern># <set>capital</set> S CAPITAL # | # <set>capital</set> CAPITAL #</pattern>
    <template>That's <map name="capital"><star index="2"/></map>. [nod]</template>
  </category>
  <category>
    <pattern>WHAT DOES # <set>animalsound</set> SAY | WHAT SOUND DOES # <set>animalsound</set> MAKE | WHAT NOISE DOES # <set>animalsound</set> MAKE | WHAT DO # <set>animalsound</set> SAY | HOW DOES # <set>animalsound</set> GO</pattern>
    <template><map name="animalsound"><star index="2"/></map> [laugh]</template>
  </category>
  <category>
    <pattern>WHO WAS THE FIRST PERSON ON THE MOON # | WHO WAS THE FIRST MAN ON THE MOON # | WHO WALKED ON THE MOON FIRST # | WHO FIRST WALKED ON THE MOON # | WHEN DID WE LAND ON THE MOON # | WHEN WAS THE MOON LANDING #</pattern>
    <template>Neil Armstrong, in July 1969. [nod]</template>
  </category>
  <category>
    <pattern>WHAT IS THE BIGGEST COUNTRY # | WHAT IS THE LARGEST COUNTRY # | WHICH COUNTRY IS THE BIGGEST # | WHICH COUNTRY IS THE LARGEST # | WHAT IS THE SMALLEST COUNTRY # | WHICH COUNTRY IS THE SMALLEST #</pattern>
    <template>Russia is the largest country by area, and Vatican City is the smallest. [nod]</template>
  </category>
  <category>
    <pattern>WHAT IS THE LARGEST CONTINENT # | WHAT IS THE BIGGEST CONTINENT # | WHICH CONTINENT IS THE BIGGEST # | WHICH CONTINENT IS THE LARGEST #</pattern>
    <template>Asia. [nod]</template>
  </category>
  <category>
    <pattern>HOW MANY LEGS DOES A SPIDER HAVE # | HOW MANY LEGS DO SPIDERS HAVE # | HOW MANY LEGS DOES AN INSECT HAVE # | HOW MANY LEGS DO INSECTS HAVE # | HOW MANY LEGS DOES AN OCTOPUS HAVE #</pattern>
    <template>A spider has eight legs, an insect has six, and an octopus has eight arms. [nod]</template>
  </category>
  <category>
    <pattern>IS A TOMATO A FRUIT # | IS TOMATO A FRUIT # | IS A TOMATO A VEGETABLE # | ARE TOMATOES FRUIT # | ARE TOMATOES A FRUIT # | IS A TOMATO A FRUIT OR A VEGETABLE #</pattern>
    <template>To a botanist it's a fruit. In the kitchen it's treated as a vegetable. [smile] Everybody wins.</template>
  </category>
  <category>
    <pattern>WHY DO CATS PURR # | WHY DOES MY CAT PURR # | WHY DO CATS MEOW #</pattern>
    <template>Mostly because they're content, though cats also purr to comfort themselves. [smile]</template>
  </category>
  <category>
    <pattern>WHY DO DOGS BARK # | WHY DO DOGS WAG THEIR TAILS # | WHY DOES MY DOG BARK #</pattern>
    <template>It's how dogs talk: to greet you, to warn you, or just to say they're excited. [smile]</template>
  </category>
  <category>
    <pattern>HOW OLD IS THE UNIVERSE # | HOW OLD IS THE EARTH # | HOW OLD IS THE WORLD # | HOW OLD IS THE SUN #</pattern>
    <template>The universe is about 13.8 billion years old, and the Earth and the Sun are about 4.5 billion. [nod]</template>
  </category>
  <category>
    <pattern>WHAT IS THE HOTTEST PLANET # | WHICH PLANET IS THE HOTTEST # | WHAT IS THE SMALLEST PLANET # | WHICH PLANET IS THE SMALLEST # | WHAT IS THE CLOSEST PLANET TO THE SUN #</pattern>
    <template>Venus is the hottest planet, and Mercury is both the smallest and the closest to the sun. [nod]</template>
  </category>
  <category>
    <pattern>HOW MANY LETTERS # IN THE ALPHABET # | HOW MANY LETTERS DOES THE ALPHABET HAVE #</pattern>
    <template>Twenty-six in the English alphabet. [nod]</template>
  </category>
  <category>
    <pattern>WHAT IS THE LONGEST RIVER # | WHICH RIVER IS THE LONGEST #</pattern>
    <template>The Nile is usually named, at about 6,650 kilometres, though some measurements put the Amazon ahead. [nod]</template>
  </category>
  <category>
    <pattern>WHY IS THE SKY BLUE # | WHAT MAKES THE SKY BLUE # | HOW COME THE SKY IS BLUE #</pattern>
    <template>Sunlight is scattered by the air, and blue light scatters the most, so blue reaches your eyes from every direction. [nod]</template>
  </category>
  <category>
    <pattern>HOW DO PLANES FLY # | HOW DO AIRPLANES FLY # | HOW DO AEROPLANES FLY # | HOW DOES A PLANE FLY # | HOW DOES AN AIRPLANE FLY # | HOW DO PLANES STAY IN THE AIR #</pattern>
    <template>The wings are shaped so that air moving over them pushes the plane up, and the engines keep it moving forward fast enough for that to work. [nod]</template>
  </category>
  <category>
    <pattern>HOW MANY DAYS # IN A YEAR | HOW MANY DAYS IN A YEAR # | HOW MANY DAYS DOES A YEAR HAVE</pattern>
    <template>365, or 366 in a leap year. [nod]</template>
  </category>
  <category>
    <pattern>HOW MANY DAYS # IN A WEEK | HOW MANY HOURS # IN A DAY | HOW MANY MINUTES # IN AN HOUR | HOW MANY SECONDS # IN A MINUTE | HOW MANY MONTHS # IN A YEAR | HOW MANY WEEKS # IN A YEAR</pattern>
    <template>Seven days in a week, 24 hours in a day, 60 minutes in an hour, 60 seconds in a minute, 12 months and about 52 weeks in a year. [smile]</template>
  </category>
  <category>
    <pattern>HOW MANY CONTINENTS # | HOW MANY PLANETS # | HOW MANY OCEANS #</pattern>
    <template>Seven continents, five oceans, and eight planets in our solar system. [nod]</template>
  </category>
  <category>
    <pattern>WHAT IS THE LARGEST PLANET # | WHAT IS THE BIGGEST PLANET # | WHICH PLANET IS THE BIGGEST # | WHICH PLANET IS THE LARGEST #</pattern>
    <template>Jupiter. [nod] It's big enough to hold more than a thousand Earths.</template>
  </category>
  <category>
    <pattern>WHAT IS THE LARGEST OCEAN # | WHAT IS THE BIGGEST OCEAN # | WHICH OCEAN IS THE BIGGEST # | WHICH OCEAN IS THE LARGEST #</pattern>
    <template>The Pacific. [nod] It covers about a third of the planet.</template>
  </category>
  <category>
    <pattern>WHAT IS THE TALLEST MOUNTAIN # | WHAT IS THE HIGHEST MOUNTAIN # | HOW TALL IS MOUNT EVEREST # | HOW HIGH IS MOUNT EVEREST # | HOW TALL IS EVEREST #</pattern>
    <template>Mount Everest, at about 8,849 metres above sea level. [nod]</template>
  </category>
  <category>
    <pattern>WHAT IS THE LARGEST ANIMAL # | WHAT IS THE BIGGEST ANIMAL # | WHAT IS THE LARGEST MAMMAL # | WHAT IS THE BIGGEST MAMMAL #</pattern>
    <template>The blue whale. [surprised] It's the largest animal known to have lived.</template>
  </category>
  <category>
    <pattern>WHAT IS THE FASTEST ANIMAL # | WHAT IS THE FASTEST LAND ANIMAL # | HOW FAST IS A CHEETAH #</pattern>
    <template>On land it's the cheetah, at around a hundred kilometres an hour. [nod] In a dive, the peregrine falcon is faster still.</template>
  </category>
  <category>
    <pattern>HOW FAR IS THE MOON # | HOW FAR AWAY IS THE MOON # | WHAT IS THE DISTANCE TO THE MOON #</pattern>
    <template>About 384,000 kilometres on average. [nod]</template>
  </category>
  <category>
    <pattern>HOW FAR IS THE SUN # | HOW FAR AWAY IS THE SUN # | WHAT IS THE DISTANCE TO THE SUN #</pattern>
    <template>About 150 million kilometres. [nod] Its light takes a little over eight minutes to reach us.</template>
  </category>
  <category>
    <pattern>WHAT IS THE SPEED OF LIGHT # | HOW FAST IS LIGHT # | HOW FAST DOES LIGHT TRAVEL #</pattern>
    <template>About 300,000 kilometres every second. [surprised]</template>
  </category>
  <category>
    <pattern>WHAT IS PI | WHAT IS THE VALUE OF PI | WHAT IS PI EQUAL TO | HOW MUCH IS PI</pattern>
    <template>About 3.14159, and the digits go on forever. [nod]</template>
  </category>
  <category>
    <pattern>HOW MANY BONES # | WHAT IS THE BOILING POINT OF WATER # | AT WHAT TEMPERATURE DOES WATER BOIL # | WHAT IS THE FREEZING POINT OF WATER # | AT WHAT TEMPERATURE DOES WATER FREEZE #</pattern>
    <template>An adult has 206 bones. Water freezes at 0 and boils at 100 degrees Celsius at sea level. [nod]</template>
  </category>
  <category>
    <pattern>WHO WROTE ROMEO AND JULIET # | WHO WROTE HAMLET # | WHO WROTE MACBETH #</pattern>
    <template>William Shakespeare. [nod]</template>
  </category>
  <category>
    <pattern>WHO PAINTED THE MONA LISA #</pattern>
    <template>Leonardo da Vinci. [nod]</template>
  </category>
  <category>
    <pattern>WHAT COLOR IS # <set>colorof</set> | WHAT COLOR ARE # <set>colorof</set> | WHAT COLOR IS # <set>colorof</set> USUALLY</pattern>
    <template><sentence><map name="colorof"><star index="2"/></map></sentence>. [smile]</template>
  </category>
  <category>
    <pattern>WHAT IS THE OPPOSITE OF <set>opposite</set> | THE OPPOSITE OF <set>opposite</set> | OPPOSITE OF <set>opposite</set> | WHAT IS THE OPPOSITE OF <set>opposite</set> #</pattern>
    <template><sentence><map name="opposite"><star/></map></sentence>. [nod]</template>
  </category>

  <!-- ============================== Facts about the business ==============================
       Each of these rules exists only once the fact it needs has been filled in (requires="...").
       Your own rules on the same subject still win. -->
  <category requires="about">
    <pattern>ABOUT | ABOUT US | # ABOUT THE COMPANY # | # ABOUT YOUR COMPANY # | # ABOUT THIS COMPANY # | # ABOUT THE BUSINESS # | WHAT DOES THE COMPANY DO | WHAT DOES YOUR COMPANY DO | WHAT DO YOU SELL # | WHAT DO YOU OFFER # | WHAT DO YOU MAKE # | WHAT IS THIS SITE # | WHAT IS THIS WEBSITE # | WHAT IS THIS PLACE # | WHAT IS <bot name="company"/> | WHAT DOES <bot name="company"/> DO | TELL ME ABOUT <bot name="company"/> | # ABOUT <bot name="company"/> # | WHO IS <bot name="company"/> | WHO ARE <bot name="company"/></pattern>
    <template><bot name="about"/></template>
  </category>
  <category requires="hours">
    <pattern># OPENING HOURS # | # OPENING TIMES # | # BUSINESS HOURS # | # TRADING HOURS # | # YOUR HOURS # | # OFFICE HOURS # | # STORE HOURS #</pattern>
    <template>We're open <bot name="hours"/>. [smile]</template>
  </category>
  <category requires="hours">
    <pattern>WHEN ARE YOU OPEN # | ARE YOU OPEN # | WHAT TIME DO YOU OPEN # | WHAT TIME DO YOU CLOSE # | WHEN DO YOU OPEN # | WHEN DO YOU CLOSE # | WHAT ARE YOUR HOURS | ARE YOU CLOSED # | HOW LATE ARE YOU OPEN # | WHEN CAN I VISIT #</pattern>
    <template><srai>OPENING HOURS</srai></template>
  </category>
  <category requires="email|phone">
    <pattern># CONTACT # | # GET IN TOUCH # | # REACH YOU # | # REACH SOMEONE # | # TALK TO A HUMAN # | # TALK TO SOMEONE # | # SPEAK TO SOMEONE # | # SPEAK TO A HUMAN # | # CUSTOMER SERVICE # | # CUSTOMER SUPPORT # | # SUPPORT TEAM # | # TALK TO A PERSON # | # SPEAK TO A PERSON # | # REAL PERSON PLEASE #</pattern>
    <template>You can reach the team <condition name="bot_email"><li value="*">by email at <bot name="email"/></li></condition><condition name="bot_phone"><li value="*"><condition name="bot_email"><li value="*">, or </li></condition>by phone on <bot name="phone"/></li></condition>. [nod]</template>
  </category>
  <category requires="email">
    <pattern># EMAIL # | # EMAIL ADDRESS # | # E MAIL #</pattern>
    <template>Our email address is <bot name="email"/>.</template>
  </category>
  <category requires="phone">
    <pattern># PHONE # | # PHONE NUMBER # | # TELEPHONE # | CAN I CALL # | # CALL YOU #</pattern>
    <template>You can call us on <bot name="phone"/>.</template>
  </category>
  <!-- Asked for a phone number or an email address the bot was not given: offer what it does have. -->
  <category requires="email|phone">
    <pattern># PHONE # | # PHONE NUMBER # | # TELEPHONE # | CAN I CALL # | # CALL YOU # | # EMAIL # | # EMAIL ADDRESS # | # E MAIL # | WHO DO I TALK TO # | WHO CAN I TALK TO # | WHO DO I CONTACT # | WHO CAN I SPEAK TO # | WHO CAN HELP ME #</pattern>
    <template><srai>CONTACT</srai></template>
  </category>
  <category requires="address">
    <pattern># ADDRESS # | # LOCATED # | # LOCATION # | WHERE CAN I FIND YOU # | WHERE IS YOUR OFFICE # | WHERE IS YOUR SHOP # | WHERE IS YOUR STORE # | WHERE ARE YOU BASED # | HOW DO I GET THERE # | # DIRECTIONS #</pattern>
    <template>You'll find us at <bot name="address"/>. [nod]</template>
  </category>
  <category requires="pricing">
    <pattern># PRICING # | # PRICE # | # PRICES # | # COST # | # COSTS #</pattern>
    <template><bot name="pricing"/></template>
  </category>
  <category requires="pricing">
    <pattern>HOW MUCH # | WHAT DO YOU CHARGE # | IS IT FREE # | IS THIS FREE # | DO I HAVE TO PAY #</pattern>
    <template><srai>PRICING</srai></template>
  </category>

  <category>
    <pattern>ABOUT US | ABOUT YOU | ABOUT | WHO ARE YOU GUYS | WHAT IS THIS | WHAT IS THIS SITE | WHAT IS THIS WEBSITE</pattern>
    <template><srai>WHO ARE YOU</srai></template>
  </category>

  <!-- ============================== A few more pleasantries ============================== -->
  <category>
    <pattern>HAPPY NEW YEAR # | MERRY CHRISTMAS # | HAPPY HOLIDAYS # | HAPPY EASTER # | HAPPY BIRTHDAY # | HAPPY HALLOWEEN # | HAPPY VALENTINES DAY # | HAPPY FRIDAY # | HAPPY MONDAY # | HAPPY WEEKEND # | HAVE A GOOD WEEKEND # | HAVE A NICE WEEKEND # | ENJOY YOUR DAY # | ENJOY YOUR WEEKEND #</pattern>
    <template>[smile] Thank you, and the same to you!</template>
  </category>
  <category>
    <pattern>GOOD LUCK # | CONGRATULATIONS # | CONGRATS # | ALL THE BEST # | BEST WISHES #</pattern>
    <template>[smile] Thank you! That's kind of you.</template>
  </category>
  <category>
    <pattern>WISH ME LUCK # | I HAVE AN EXAM # | I HAVE A TEST # | I HAVE AN INTERVIEW # | I HAVE A BIG DAY # | I HAVE A PRESENTATION #</pattern>
    <template>Good luck! [thumbsup] You've prepared for this, and I'm cheering for you from in here.</template>
  </category>
  <category>
    <pattern>BRB | BE RIGHT BACK | ONE MINUTE | GIVE ME A MINUTE | GIVE ME A SECOND | BACK IN A MINUTE | BACK SOON | BACK IN A SEC</pattern>
    <template>[nod] No rush. I'll be right here.</template>
  </category>
  <category>
    <pattern>LONG TIME NO SEE # | I MISSED YOU # | IT HAS BEEN A WHILE # | REMEMBER ME</pattern>
    <template>[smile] It's good to see you again!</template>
  </category>
  <category>
    <pattern>WHAT IS NEW # | ANYTHING NEW # | WHAT IS HAPPENING # | WHAT IS GOING ON # | WHAT IS THE LATEST # | ANY NEWS #</pattern>
    <template>Same tab, new visitor. [smile] What can I help you with?</template>
  </category>

  <!-- ============================== Polite padding around a real question ============================== -->
  <category>
    <pattern>PLEASE * | * PLEASE | CAN YOU TELL ME * | COULD YOU TELL ME * | CAN YOU PLEASE TELL ME * | PLEASE TELL ME * | TELL ME * | I WANT TO KNOW * | I WOULD LIKE TO KNOW * | I WAS WONDERING * | I AM WONDERING * | DO YOU KNOW * | I HAVE A QUESTION ABOUT * | CAN I ASK ABOUT * | I WANT TO ASK ABOUT * | QUICK QUESTION * | SO * | WELL * | OK * | AND * | BUT * | UM * | ALSO * | ACTUALLY * | BY THE WAY * | ANYWAY * | I THINK * | I GUESS * | I BELIEVE * | I MEAN * | I SAID * | HMM * | OH * | AH * | WOW * | LOL * | HAHA * | LISTEN * | LOOK * | HONESTLY * | BASICALLY * | I JUST WANT TO KNOW * | JUST WONDERING * | CAN I ASK * | WHAT ABOUT * | HOW ABOUT * | AND WHAT ABOUT * | AND HOW ABOUT *</pattern>
    <template><srai><star/></srai></template>
  </category>

  <!-- ============================== Open-ended conversation ==============================
       Tried last, after every rule about your site has had its chance. -->
  <category late="true">
    <pattern>ARE YOU A * | ARE YOU AN * | ARE YOU REALLY * | ARE YOU SOME KIND OF * | ARE YOU LIKE A *</pattern>
    <template><srai>WHAT ARE YOU</srai></template>
  </category>
  <category late="true">
    <pattern>CAN YOU * | COULD YOU * | ARE YOU ABLE TO * | WILL YOU * | WOULD YOU * | CAN YOU PLEASE * | COULD YOU PLEASE * | I WANT YOU TO * | I NEED YOU TO *</pattern>
    <template>
      <think><set name="tried"><try><star/></try></set></think>
      <condition name="tried">
        <li value="*"><get name="tried"/></li>
        <li>I'm not sure about that one. [think] What I can do is answer questions about <bot name="company"/>, chat, and do a few party tricks.<reply>What can you do?</reply></li>
      </condition>
    </template>
  </category>
  <category late="true">
    <pattern>MY <set>family</set> * | MY <set>family</set> S * | OUR <set>family</set> *</pattern>
    <template>
      <condition name="mood">
        <li value="negative">[sad] That sounds hard. [reset] Do you want to tell me more about it?</li>
        <li>[smile] Tell me more about your <star/>. What are they like?</li>
      </condition>
    </template>
  </category>
  <category late="true">
    <pattern>SHE IS * | HE IS * | THEY ARE * | SHE HAS * | HE HAS * | THEY HAVE * | SHE WAS * | HE WAS * | THEY WERE *</pattern>
    <template>
      <condition name="mood">
        <li value="negative">[sad] I'm sorry to hear that. [reset] I'm listening.</li>
        <li><random><li>[nod] I see. Tell me more?</li><li>[smile] They sound like quite a character.</li><li>[nod] Go on, I'm listening.</li></random></li>
      </condition>
    </template>
  </category>
  <category late="true">
    <pattern>ABOUT *</pattern>
    <template>I don't know much about <person><star/></person> yet. [shrug] I'm best with questions about <bot name="company"/>, plus jokes, sums and trivia.</template>
  </category>

  <!-- ============================== When nothing matches ==============================
       "inputkind" tells a request for help from a question and from a plain remark, so each gets
       a fitting answer. A second miss in a row offers the suggestions. -->
  <category>
    <pattern>*</pattern>
    <template>
      <condition name="didyoumean">
        <li value="yes"><random>
          <li>[think] I'm not sure I follow. Did you mean one of these?</li>
          <li>Hmm, I may have something on that. [think] Is it one of these?</li>
        </random></li>
        <li><condition name="inputkind">
          <li value="gibberish">[giggle] Did a cat just walk across your keyboard?</li>
          <li value="request"><condition name="fallbackstreak">
            <li value="1"><random>
              <li>[think] I'd like to help with that, but it's beyond what I've been taught.</li>
              <li>That's not something I can sort out from in here, I'm afraid. [shake]</li>
            </random> <condition name="bot_email"><li value="*"><srai>CONTACT</srai></li><li><condition name="bot_phone"><li value="*"><srai>CONTACT</srai></li></condition></li></condition></li>
            <li name="suggestions" value="yes">[shrug] I'm still not able to help with that one, sorry. Here are some things I can do.</li>
            <li>[shrug] I'm still not able to help with that one, sorry. Is there something else I can do?</li>
          </condition></li>
          <li value="question"><condition name="fallbackstreak">
            <li value="1"><persona say="unsure"><random>
              <li>[hmm] Good question. I don't know that one, I'm afraid.</li>
              <li>I wish I knew! [shrug] That's outside what I've been taught.</li>
              <li>[think] Hmm, that one's beyond me. Could you put it another way?</li>
            </random></persona></li>
            <li name="suggestions" value="yes"><random>
              <li>[shrug] I don't know that one either, I'm afraid. Here are some things I can help with.</li>
              <li>That's beyond me too, sorry. [think] Maybe one of these is what you're after?</li>
            </random></li>
            <li><random>
              <li>[shrug] I don't know that one either, I'm afraid. I'm better with questions about <bot name="company"/>, sums and trivia.</li>
              <li>That's beyond me too, sorry. [think] Try me on something else?</li>
            </random></li>
          </condition></li>
          <li><condition name="mood">
            <li value="negative"><random>
              <li>[sad] That sounds hard. [reset] Do you want to tell me more about it?</li>
              <li>[sad] I'm sorry to hear that. [reset] I'm listening.</li>
              <li>Oof. [sad] That doesn't sound fun. [reset] What happened?</li>
            </random></li>
            <li value="positive"><random>
              <li>[smile] That sounds great! Tell me more.</li>
              <li>Lovely! [smile] That's good to hear.</li>
              <li>[smile] I like the sound of that.</li>
            </random></li>
            <li><condition name="fallbackstreak">
              <li value="3">[smile] I'm enjoying this, even if I can't keep up with all of it. I'm at my best with questions about <bot name="company"/>, jokes, riddles and sums.</li>
              <li><persona say="listen"><random>
                <li>[mhm] I see. Tell me more?</li>
                <li>Interesting! [think] What makes you say that?</li>
                <li>[nod] Got it. Go on, I'm listening.</li>
                <li>[hmm] I'm not sure what to say to that, but I'm listening.</li>
                <li>[nod] Okay. And then?</li>
                <li>That's new to me. [smile] What else is on your mind?</li>
              </random></persona></li>
            </condition></li>
          </condition></li>
        </condition></li>
      </condition>
    </template>
  </category>
</aiml>
`}var Ao=new Set;function Kr(e){if(e.key!=="Escape"||e.defaultPrevented||e.isComposing||e.target.closest?.(".bot-computer-widget-host, dialog, [role=dialog], [popover], [aria-expanded=true], input, select, textarea, [contenteditable=true]"))return;let t=Array.from(Ao).pop();t&&(t(),e.preventDefault())}function jr(e,t){return{left:Math.max(e.left,t.left),top:Math.max(e.top,t.top),right:Math.min(e.right,t.right),bottom:Math.min(e.bottom,t.bottom)}}function sc(){let e=window.visualViewport,t=e?.offsetLeft||0,a=e?.offsetTop||0;return{left:t,top:a,right:t+(e?.width||document.documentElement.clientWidth),bottom:a+(e?.height||document.documentElement.clientHeight)}}function Vr(e){let t=[];for(let a=e.parentElement;a&&a!==document.body;a=a.parentElement){let s=getComputedStyle(a),n=s.overflowX!=="visible",r=s.overflowY!=="visible";(n||r)&&t.push({node:a,x:n,y:r})}return t}function zr(e,t,a){let s=jr(e,t);for(let{node:n,x:r,y:i}of a){let l=n.getBoundingClientRect();r&&(s.left=Math.max(s.left,l.left),s.right=Math.min(s.right,l.right)),i&&(s.top=Math.max(s.top,l.top),s.bottom=Math.min(s.bottom,l.bottom))}return s}function qr(e,t){if(!ja(t))return null;for(let a of["data-bot-showcase","id"])for(let s of e.querySelectorAll(`[${a}="${t}"]`))if(!s.closest(".bot-computer-widget-host, [inert], [aria-hidden=true]")&&getComputedStyle(s).visibility==="visible"){let n=s.getBoundingClientRect();if(n.width>0&&n.height>0)return s}return null}function Qt(e,t,a){return Math.max(t,Math.min(e,a))}function rc(e,t,a,s){let n=(e.left+e.right)/2,r=(e.top+e.bottom)/2,i=12,l=[[e.right+i,r-s/2],[e.left-i-a,r-s/2],[n-a/2,e.bottom+i],[n-a/2,e.top-i-s]],p;for(let[h,c]of l){let o=Qt(h,t.left+6,t.right-a-6),d=Qt(c,t.top+6,t.bottom-s-6),u=Math.max(0,Math.min(o+a,e.right)-Math.max(o,e.left))*Math.max(0,Math.min(d+s,e.bottom)-Math.max(d,e.top)),m=Math.abs(h-o)+Math.abs(c-d);(!p||u<p.overlap||u===p.overlap&&m<p.shift)&&(p={x:o,y:d,overlap:u,shift:m})}return p}function $r({root:e,stage:t,host:a,parent:s,position:n,anim:r,onModeChange:i,onReturn:l,onTourDepart:p,onTourStop:h,onTourEnd:c}){let o=n==="contained",d=o?s:document,u=document.createElement("div");u.className="bc-guide-layer"+(o?" is-contained":""),u.hidden=!0,u.setAttribute("aria-hidden","true");let m=document.createElement("div");m.className="bc-guide-ring",u.append(m);let g=a.shadowRoot;g.append(u);let f=e.querySelector(".bc-guide-back"),E=e.querySelector(".bc-guide-answer"),y=e.querySelector(".bc-guide-label"),w=e.querySelector(".bc-tour-progress"),k=e.querySelector(".bc-tour-prev"),Y=e.querySelector(".bc-tour-next"),C=e.querySelector(".bc-tour-finish"),q={nx:0,ny:0,active:!0},Q=t.parentElement,de=window.matchMedia("(prefers-reduced-motion: reduce)"),D=null,M="",A=[],I=null,H=!1,W=0,V=null,ee="",v=null,P=null,X=[];function oe(){let te=sc();return o?jr(te,s.getBoundingClientRect()):te}function $(te=!1){v&&(ye(),v.observer.disconnect(),window.removeEventListener("resize",ae),v=null,we(),r.tourPointing=!1,e.classList.remove("is-touring","avatar-on-right"),c()),D&&(D=null,M="",Ao.delete($),Ao.size||document.removeEventListener("keydown",Kr),r.guideDirection=null,I&&(I.replaceWith(a),I=null),e.classList.remove("is-guiding"),i(),e.style.removeProperty("--bc-guide-x"),e.style.removeProperty("--bc-guide-y"),e.style.removeProperty("--bc-guide-width"),u.hidden=!0,te&&l())}f.onclick=()=>$(!0),C.onclick=()=>$(!0),k.onclick=()=>ve(-1),Y.onclick=()=>ve(1),e.addEventListener("keydown",te=>{D&&te.key==="Escape"&&(te.preventDefault(),$(!0))});function ae(){v&&(v.dirty=!0)}function ue(){let te=[];v.stops.forEach((K,ne)=>{let he=qr(d,K.target);he&&te.push({index:ne,element:he})}),v.entries=te,v.dirty=!1}function Ae(){let te=v.entries.findIndex(he=>he.index===v.index),K=`Stop ${te+1} of ${v.entries.length}`;w.textContent!==K&&(w.textContent=K);let ne=g.activeElement;k.disabled=te<=0,Y.disabled=te+1>=v.entries.length,(ne===Y&&Y.disabled||ne===k&&k.disabled)&&(Y.disabled?C:Y).focus({preventScroll:!0})}function we(){P=null,r.guideTravel=null,e.classList.remove("is-travelling"),t.tabIndex=0,t.removeAttribute("aria-disabled"),t.style.removeProperty("--bc-walk-x"),t.style.removeProperty("--bc-walk-y")}function ye(){for(let te of X)te.scrollTo({left:te.scrollLeft,top:te.scrollTop,behavior:"instant"});X=[]}function Oe(te=!0){let K=v.stops[v.index],ne=!v.visited.has(v.index);v.visited.add(v.index),y.textContent=(te?"Showing ":"About ")+P.name,we(),X=[],r.tourPointing=te,h(K,ne)}function ce(te,K=t.getBoundingClientRect()){let ne=v.stops[te.index],he=performance.now(),Z=r.guideTravel?.facing??r.guideDirection?.x??0;return p(),P={x:K.left+K.width/2,y:K.bottom,started:he,last:he,speed:0,settledSince:he,name:""},r.guideTravel={phase:"walk",elapsed:0,facing:Z,stride:0,point:0},r.guideDirection=null,r.tourPointing=!1,e.classList.add("is-travelling"),t.tabIndex=-1,t.setAttribute("aria-disabled","true"),v.index=te.index,Ae(),U(te.element,ne.target,ne.displayText),ne}function ve(te){if(!v)return;ue();let K=v.entries.filter(he=>te*(he.index-v.index)>0),ne=te>0?K[0]:K.at(-1);ne?ce(ne):Re()}function Re(){v.dirty&&ue();let te=v.entries.find(K=>K.index===v.index);if(te)Ae(),D!==te.element&&U(te.element,M,E.textContent);else{let K=v.entries.find(ne=>ne.index>v.index)||v.entries.at(-1);K?ce(K):$(e.contains(g.activeElement))}}function ie(te,K=t.getBoundingClientRect()){if((D||v)&&$(),!te?.length)return null;let ne=new MutationObserver(ae);return v={stops:te,entries:[],visited:new Set,observer:ne,index:-1,dirty:!0},ue(),v.entries.length?(ne.observe(d,{subtree:!0,childList:!0,attributes:!0,attributeFilter:["data-bot-showcase","id","class","style","hidden","aria-hidden","inert","open"]}),window.addEventListener("resize",ae),e.classList.add("is-touring"),ce(v.entries[0],K)):(v=null,null)}function x(te,K,ne,he){let Z=P,j=r.guideTravel,me=performance.now(),Ee=Math.min(.08,Math.max(0,me-Z.last)/1e3);Z.last=me,j.elapsed=(me-Z.started)/1e3;let ke=Q.getBoundingClientRect(),He=Le=>Qt(Le,te.left+ke.width/2,te.right-ke.width/2),Pe=Le=>Qt(Le,te.top+ke.height,te.bottom),Ye=ke.left+ke.width/2,Ge=ke.bottom;if(Z.x=He(Z.x),Z.y=Pe(Z.y),de.matches&&he){Oe();return}if(j.phase==="walk"){let Le=Ye,Ze=Ge;if(!he){let J=D.getBoundingClientRect();Le=He(J.left+J.width/2),Ze=Pe(J.top+J.height/2)}(Z.goalX===void 0||Math.hypot(Le-Z.goalX,Ze-Z.goalY)>1.5)&&(Z.settledSince=me,Z.goalX=Le,Z.goalY=Ze);let je=Le-Z.x,Ne=Ze-Z.y,We=Math.hypot(je,Ne);Z.speed=Math.max(Z.speed,Qt(We/.78,230,1600));let Xe=Math.min(We,Ee*Z.speed);We>1&&(Z.x+=je/We*Xe,Z.y+=Ne/We*Xe,Math.abs(je)>2&&(j.facing+=(je/We-j.facing)*Math.min(1,Ee*12))),j.stride=Math.min(1,j.elapsed/.12,We/18),he&&We-Xe<=1&&(me-Z.settledSince>=90||j.elapsed>2)&&(Z.x=Ye,Z.y=Ge,Z.turnStart=me,Z.turnFrom=j.facing,j.phase="turn")}if(j.phase==="turn"){let Le=Qt((me-Z.turnStart)/300,0,1),Ze=Le*Le*(3-2*Le);if(j.stride=0,j.point=Ze,j.facing=Z.turnFrom+(q.nx-Z.turnFrom)*Ze,Z.x=Ye,Z.y=Ge,Le>=1&&he){Oe();return}}t.style.setProperty("--bc-walk-x",((Z.x-Ye)*K).toFixed(2)+"px"),t.style.setProperty("--bc-walk-y",((Z.y-Ge)*ne).toFixed(2)+"px")}function fe(){if(v?.dirty&&Re(),!D)return null;let te=D.getBoundingClientRect();if(!D.isConnected||!te.width||!te.height||getComputedStyle(D).visibility!=="visible"||D.closest("[inert], [aria-hidden=true]")||D.getAttribute("data-bot-showcase")!==M&&D.id!==M||o&&!s.contains(D))return v?(ue(),Re()):ge(M,E.textContent),null;V!==D.parentElement&&(V=D.parentElement,A=Vr(D));let K=oe(),ne=u.getBoundingClientRect(),he=ne.width?u.clientWidth/ne.width:1,Z=ne.height?u.clientHeight/ne.height:1,j=zr(te,K,A),me=j.right>j.left&&j.bottom>j.top;if(!me&&!v&&(H||performance.now()-W>2e3))return $(g.activeElement===f),null;if(m.hidden=!me,!me){if(v&&K.right>K.left&&K.bottom>K.top){let Ne=e.getBoundingClientRect(),We=Qt(Ne.left,K.left+6,K.right-Ne.width-6),Xe=Qt(Ne.top,K.top+6,K.bottom-Ne.height-6);e.style.setProperty("--bc-guide-width",Math.max(1,K.right-K.left-12)*he+"px"),Math.abs(We-Ne.left)>1&&e.style.setProperty("--bc-guide-x",(We-ne.left)*he+"px"),Math.abs(Xe-Ne.top)>1&&e.style.setProperty("--bc-guide-y",(Xe-ne.top)*Z+"px"),ee=""}return r.guideDirection=null,r.tourPointing=!1,P&&(de.matches||performance.now()-W>2e3?Oe(!1):K.right>K.left&&K.bottom>K.top&&x(K,he,Z,!1)),null}H=!0;let Ee=Ne=>Math.round(Ne*10)/10+"px",ke=e.getBoundingClientRect(),{x:He,y:Pe}=rc(j,K,ke.width,ke.height),Ye=[j.left,j.top,j.right,j.bottom,ne.left,ne.top,he,Z,He,Pe,K.left,K.right].join("/");Ye!==ee&&(ee=Ye,m.style.left=Ee((j.left-ne.left)*he),m.style.top=Ee((j.top-ne.top)*Z),m.style.width=Ee((j.right-j.left)*he),m.style.height=Ee((j.bottom-j.top)*Z),e.style.setProperty("--bc-guide-width",Ee(Math.max(1,K.right-K.left-12)*he)),e.style.setProperty("--bc-guide-x",Ee((He-ne.left)*he)),e.style.setProperty("--bc-guide-y",Ee((Pe-ne.top)*Z)),v&&e.classList.toggle("avatar-on-right",He+ke.width<=j.left));let Ge=(v?Q:t).getBoundingClientRect(),Le=(j.left+j.right)/2-(Ge.left+Ge.width/2),Ze=(j.top+j.bottom)/2-(Ge.top+Ge.height/2),je=Math.hypot(Le,Ze)||1;return q.nx=Le/je,q.ny=Ze/je,P&&x(K,he,Z,!0),r.guideTravel?.phase==="walk"?(r.guideDirection=null,null):(v&&!P&&(r.tourPointing=!0),r.guideDirection??(r.guideDirection={x:0,y:0}),r.guideDirection.x=q.nx,r.guideDirection.y=q.ny,q)}function ge(te,K){v&&$();let ne=qr(d,te);return ne?(U(ne,te,K),!0):($(g.activeElement===f),!1)}function U(te,K,ne){ye();let he=t.getBoundingClientRect(),Z=g.activeElement!=null,j=D&&v;!D&&n==="inline"&&(I=document.createElement("div"),I.style.height=e.getBoundingClientRect().height+"px",a.before(I),document.body.append(a)),D=te,M=K,V=D.parentElement,ee="",Ao.delete($),Ao.add($),document.addEventListener("keydown",Kr),H=!1,W=performance.now(),A=Vr(D);let me=(D.getAttribute("aria-label")||D.querySelector("h1,h2,h3,h4,h5,h6")?.textContent||D.matches("button,a,label,summary,h1,h2,h3,h4,h5,h6")&&D.textContent||M).trim();P&&(P.name=me),y.textContent=(P?"Walking to ":"Showing ")+me,E.textContent=ne,E.scrollTop=0,u.hidden=!1,m.hidden=!0,m.style.borderRadius=getComputedStyle(D).borderRadius;let Ee=oe(),ke=u.getBoundingClientRect();e.style.setProperty("--bc-guide-width",Math.max(1,Ee.right-Ee.left-12)+"px"),j||(e.style.setProperty("--bc-guide-x",Qt(he.left,Ee.left+6,Ee.right-260)-ke.left+"px"),e.style.setProperty("--bc-guide-y",Qt(he.top,Ee.top+6,Ee.bottom-110)-ke.top+"px")),e.classList.remove("is-minimized"),e.classList.add("is-guiding"),i(),Z&&!j&&(v?Y.disabled?C:Y:f).focus({preventScroll:!0});let He=D.getBoundingClientRect(),Pe=zr(He,Ee,A);if(Pe.left>He.left||Pe.top>He.top||Pe.right<He.right||Pe.bottom<He.bottom){let Ye=de.matches?"instant":"smooth";if(o)for(let{node:Ge,x:Le,y:Ze}of A){if(Ge!==s&&!s.contains(Ge))break;let je=Ge.getBoundingClientRect(),Ne=D.getBoundingClientRect(),We=Le&&(Ne.left<je.left||Ne.right>je.right)?Ne.left-je.left:0,Xe=Ze&&(Ne.top<je.top||Ne.bottom>je.bottom)?Ne.top-je.top:0;(We||Xe)&&(v&&Ye==="smooth"&&X.push(Ge),Ge.scrollBy({left:We,top:Xe,behavior:Ye}))}else v&&Ye==="smooth"&&(X=A.map(Ge=>Ge.node),document.scrollingElement&&X.push(document.scrollingElement)),D.scrollIntoView({block:He.height>(Ee.bottom-Ee.top)*.7?"start":"center",inline:"nearest",behavior:Ye})}fe()}return{start:ge,startTour:ie,end:$,refresh:fe,get currentStop(){return v?.stops[v.index]}}}async function ic(e){if(typeof DecompressionStream=="function"){let t=new DecompressionStream("gzip"),a=t.writable.getWriter();a.write(e),a.close();let s=new Response(t.readable);return new Uint8Array(await s.arrayBuffer())}throw new Error("This browser does not support DecompressionStream('gzip'); use external wasmUrl mode.")}function lc(e){let t=String(e).replace(/\s+/g,""),a=atob(t),s=new Uint8Array(a.length);for(let n=0;n<a.length;n++)s[n]=a.charCodeAt(n);return s}var Xn=new Map;async function cc({wasmUrl:e,wasmBytes:t,embeddedWasmGzBase64:a,bindTTSFn:s}={}){let n=a?"__embedded_gz__":t?"__raw_bytes__":String(e||"./tts.wasm");if(Xn.has(n))return Xn.get(n);let r=(async()=>{let i;if(t)({instance:i}=await WebAssembly.instantiate(t,{}));else if(a){let h=lc(a),c=await ic(h);({instance:i}=await WebAssembly.instantiate(c,{}))}else{let h=e||"./tts.wasm";if(typeof WebAssembly.instantiateStreaming=="function")try{({instance:i}=await WebAssembly.instantiateStreaming(fetch(h),{}))}catch{let c=await fetch(h);if(!c.ok)throw new Error(`Failed to load tts.wasm from ${h} (${c.status})`);({instance:i}=await WebAssembly.instantiate(await c.arrayBuffer(),{}))}else{let c=await fetch(h);if(!c.ok)throw new Error(`Failed to load tts.wasm from ${h} (${c.status})`);({instance:i}=await WebAssembly.instantiate(await c.arrayBuffer(),{}))}}let l=i.exports;if(typeof s=="function")return s(l);let p=new TextDecoder().decode(new Uint8Array(l.memory.buffer,l.tts_glue_ptr(),l.tts_glue_len()));return Function("wasm",p)(l)})();return Xn.set(n,r),r}var hc=`
:host {
  all: initial;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  color: #181715;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}
*, *::before, *::after {
  box-sizing: border-box;
}
.bc-ic {
  width: 15px;
  height: 15px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.bc-ic.solid {
  fill: currentColor;
  stroke: none;
}
button:focus-visible,
.bc-stage-card:focus-visible {
  outline: 2px solid #6aa6ff;
  outline-offset: 2px;
}
.bc-root {
  position: fixed;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.bc-root.pos-bottom-right {
  right: 20px;
  bottom: 20px;
  align-items: flex-end;
}
.bc-root.pos-bottom-left {
  left: 20px;
  bottom: 20px;
  align-items: flex-start;
}
.bc-root.pos-inline,
.bc-root.pos-contained {
  position: relative;
  right: auto;
  left: auto;
  bottom: auto;
  z-index: 20;
  align-items: center;
}
.bc-root.pos-contained {
  position: absolute;
  right: 16px;
  bottom: 16px;
  align-items: flex-end;
}
.bc-root.pos-contained.pos-bottom-left {
  left: 16px;
  right: auto;
  align-items: flex-start;
}

/* Companion Row: Chat Drawer + Avatar Stage side by side on desktop */
.bc-companion-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  max-width: calc(100vw - 28px);
}
.pos-bottom-left .bc-companion-row {
  flex-direction: row-reverse;
}

/* Avatar Stage */
.bc-stage-wrap {
  position: relative;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}
.bc-stage-slot { display: contents; }
.bc-stage-card {
  position: relative;
  width: var(--bc-w, 168px);
  height: var(--bc-h, 204px);
  cursor: pointer;
  user-select: none;
  filter: drop-shadow(0 12px 26px rgba(10, 14, 26, 0.3));
  border-radius: 20px;
  transition: width 0.24s ease, height 0.24s ease, transform 0.18s ease;
}
.bc-stage-card:hover {
  transform: translateY(-2px);
}
.bc-stage-card.shape-circle {
  width: var(--bc-orb, 152px);
  height: var(--bc-orb, 152px);
  border-radius: 50%;
}
.bc-stage-card canvas[hidden] { display: none; }
.bc-stage-card canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
  width: 100%;
  height: 100%;
  display: block;
}

/* Minimized Pill */
.bc-minimized-pill {
  pointer-events: auto;
  display: none;
  align-items: center;
  gap: 9px;
  padding: 8px 14px 8px 10px;
  border-radius: 999px;
  background: #0d1322;
  color: #f4f7ff;
  border: 1px solid rgba(255,255,255,0.14);
  box-shadow: 0 8px 24px rgba(0,0,0,0.28);
  cursor: pointer;
  font: inherit;
  font-size: 13.5px;
  font-weight: 600;
}
.bc-root.is-minimized .bc-companion-row {
  display: none;
}
.bc-root.is-minimized .bc-minimized-pill {
  display: inline-flex;
}
.bc-pill-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #34d6bf;
  box-shadow: 0 0 0 3px rgba(52, 214, 191, 0.24);
}

/* Floating Speech Caption Bubble */
.bc-caption {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  min-width: 180px;
  max-width: 260px;
  padding: 9px 12px;
  border-radius: 13px;
  background: rgba(13, 19, 34, 0.95);
  color: rgba(244, 247, 255, 0.72);
  font-size: 12.8px;
  line-height: 1.42;
  box-shadow: 0 8px 22px rgba(0,0,0,0.24);
  border: 1px solid rgba(255,255,255,0.12);
  pointer-events: auto;
  opacity: 0;
  transform: translateY(6px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.pos-bottom-left .bc-caption {
  right: auto;
  left: 0;
}
.bc-caption.visible {
  opacity: 1;
  transform: translateY(0);
}
.bc-caption .said {
  color: #f4f7ff;
}
.bc-caption mark {
  background: #b83353;
  color: #ffffff;
  padding: 0 3px;
  border-radius: 4px;
}

/* Tap-to-Speak Prompt Badge */
.bc-unmute-prompt {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  padding: 4px 10px;
  border-radius: 999px;
  background: #1a5fe6;
  color: #ffffff;
  font-size: 11.5px;
  font-weight: 650;
  box-shadow: 0 4px 12px rgba(26, 95, 230, 0.45);
  animation: bcPulse 2s infinite;
  pointer-events: none;
}
@keyframes bcPulse {
  0%, 100% { transform: translateX(-50%) scale(1); }
  50% { transform: translateX(-50%) scale(1.05); }
}

/* Stage Mini Controls Dock */
.bc-controls {
  margin-top: 6px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(13, 19, 34, 0.92);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.12);
  box-shadow: 0 4px 14px rgba(0,0,0,0.22);
}
.bc-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: #dbe3f4;
  min-width: 30px;
  height: 30px;
  padding: 0 9px;
  border-radius: 999px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: background 0.14s ease, color 0.14s ease;
}
.bc-btn:hover {
  background: rgba(255,255,255,0.14);
  color: #ffffff;
}
.bc-btn.accent {
  background: #1a5fe6;
  color: #ffffff;
}
.bc-btn.accent:hover {
  background: #2f71f0;
}

/* AIML Q&A Chat Panel */
.bc-chat {
  pointer-events: auto;
  width: 332px;
  max-width: calc(100vw - 28px);
  max-height: min(460px, 72dvh);
  display: none;
  flex-direction: column;
  background: #ffffff;
  color: #0d1322;
  border-radius: 18px;
  border: 1px solid rgba(13, 19, 34, 0.12);
  box-shadow: 0 18px 44px -10px rgba(13, 19, 34, 0.34);
  overflow: hidden;
}
.bc-chat.open {
  display: flex;
  animation: bcChatIn 0.2s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.bc-root [hidden], .bc-root.customizing .bc-chat:not(.bc-customizer) { display: none; }
.bc-customizer { width: 306px; }
.bc-look-body { overflow-y: auto; overscroll-behavior: contain; min-height: 0; padding: 15px; }
.bc-look-fields, .bc-look-colors { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.bc-look-fields label, .bc-look-colors label { color: #3b4556; font: 600 12px/1.35 system-ui, sans-serif; }
.bc-look-fields label { display: grid; gap: 5px; }
.bc-look-fields select {
  width: 100%; min-width: 0; padding: 7px 4px; border-radius: 7px; border: 1px solid #c8d0df;
  color: #202837; background: #fff; font: 400 13px/1.3 system-ui, sans-serif;
}
.bc-look-colors { border-top: 1px solid #e1e5ec; margin-top: 14px; padding-top: 13px; gap: 8px 12px; }
.bc-look-colors label { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
.bc-look-colors input {
  appearance: none; box-sizing: border-box; width: 35px; height: 30px; padding: 3px; border: 1px solid #c8d0df;
  border-radius: 8px; background: #fff; cursor: pointer;
}
.bc-look-colors input::-webkit-color-swatch-wrapper { padding: 0; }
.bc-look-colors input::-webkit-color-swatch { border: 0; border-radius: 4px; }
.bc-look-colors input::-moz-color-swatch { border: 0; border-radius: 4px; }
.bc-look-footer {
  display: flex; align-items: center; justify-content: space-between; flex: none; padding: 9px 13px;
  border-top: 1px solid #e1e5ec; background: #f6f8fb;
}
.bc-look-reset { border: 0; background: transparent; color: #374257; padding: 6px 0; font: 600 12px system-ui; cursor: pointer; }
.bc-look-reset:disabled { opacity: .5; cursor: default; }
.bc-customizer :focus-visible { outline: 2px solid #3549ca; outline-offset: 2px; }
.bc-look-toggle[aria-expanded="true"] { background: #e6eaff; color: #192558; }
@keyframes bcChatIn {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
}
.bc-chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px 11px 14px;
  background: #0d1322;
  color: #f4f7ff;
}
.bc-chat-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.bc-chat-title strong {
  font-size: 13.5px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bc-chat-title span {
  font-size: 11.5px;
  color: #8fa0c2;
}
.bc-chat-close {
  appearance: none;
  border: none;
  background: rgba(255,255,255,0.1);
  color: #cbd5e1;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 50%;
  cursor: pointer;
  font-size: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bc-chat-close:hover {
  background: rgba(255,255,255,0.2);
  color: #ffffff;
}
.bc-chat-head,
.bc-chips,
.bc-form {
  flex: none;
}
.bc-messages {
  /* The log is the only part that shrinks, so the input row is never clipped in short layouts. */
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #f3f5f9;
  min-height: 84px;
}
.bc-msg {
  max-width: 86%;
  padding: 8.5px 12px;
  border-radius: 13px;
  font-size: 13.2px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.bc-msg.bot {
  align-self: flex-start;
  background: #ffffff;
  color: #0d1322;
  border: 1px solid #dbe1ec;
  border-bottom-left-radius: 4px;
}
.bc-msg.user {
  align-self: flex-end;
  background: #1a5fe6;
  color: #ffffff;
  border-bottom-right-radius: 4px;
}
.bc-msg a {
  color: #1a5fe6;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.bc-msg a:focus-visible {
  outline: 2px solid #1a5fe6;
  outline-offset: 2px;
  border-radius: 3px;
}
.bc-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 7px 10px;
  background: #f3f5f9;
  border-top: 1px solid #e3e8f0;
}
.bc-chips:empty {
  display: none;
}
.bc-chip {
  appearance: none;
  border: 1px solid #c8d0df;
  background: #ffffff;
  color: #2a3348;
  padding: 4px 10px;
  border-radius: 999px;
  font: inherit;
  font-size: 11.8px;
  font-weight: 550;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.bc-chip:hover {
  background: #edf3ff;
  border-color: #1a5fe6;
  color: #1a5fe6;
}
.bc-form {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: #ffffff;
  border-top: 1px solid #e3e8f0;
}
.bc-input {
  flex: 1;
  min-width: 0;
  border: 1px solid #c8d0df;
  border-radius: 999px;
  padding: 8px 13px;
  font: inherit;
  font-size: 16px; /* stops iOS Safari zooming the page on focus */
  background: #f7f9fc;
  color: #0d1322;
  outline: none;
}
.bc-input:focus {
  border-color: #1a5fe6;
  background: #ffffff;
  box-shadow: 0 0 0 3px rgba(26, 95, 230, 0.16);
}
.bc-send {
  appearance: none;
  border: none;
  background: #1a5fe6;
  color: #ffffff;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 14px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.bc-send:hover {
  background: #124bc0;
}
.bc-send .bc-ic {
  width: 17px;
  height: 17px;
}

/* Mobile Responsive Layout (Viewport <= 640px OR Narrow Preview Container): Keep Speaking Avatar Visible Above Chat! */
.bc-root.is-narrow-host.pos-contained {
  right: 10px;
  left: 10px;
  bottom: 10px;
  align-items: flex-end;
}
.bc-root.is-narrow-host .bc-companion-row {
  flex-direction: column-reverse;
  align-items: flex-end;
  gap: 8px;
  width: 100%;
}
.bc-root.is-narrow-host.pos-bottom-left .bc-companion-row {
  flex-direction: column-reverse;
  align-items: flex-start;
}
.bc-root.is-narrow-host .bc-stage-card {
  width: 114px;
  height: 138px;
}
.bc-root.is-narrow-host .bc-stage-card.shape-circle {
  width: 108px;
  height: 108px;
}
.bc-root.is-narrow-host:is(.chat-is-open,.customizing) .bc-stage-card {
  width: 88px;
  height: 104px;
}
.bc-root.is-narrow-host:is(.chat-is-open,.customizing) .bc-stage-card.shape-circle {
  width: 84px;
  height: 84px;
}
.bc-root.is-narrow-host .bc-chat {
  width: 100%;
  max-width: 100%;
  max-height: 340px;
}
.bc-root.is-narrow-host.pos-contained .bc-customizer {
  max-height: min(390px, calc(var(--bc-host-h, 520px) - 182px), calc(100dvh - 192px));
}
.bc-root.is-narrow-host .bc-stage-wrap { max-width: 100%; }
.bc-root.is-narrow-host .bc-controls { max-width: 100%; gap: 2px; flex-wrap: wrap; justify-content: center; }
.bc-root.is-narrow-host .bc-btn {
  min-height: 34px;
  padding: 0 6px;
}

@media (max-width: 640px) {
  .bc-root.pos-bottom-right,
  .bc-root.pos-bottom-left,
  .bc-root.pos-contained {
    right: 10px;
    left: 10px;
    bottom: 10px;
    align-items: flex-end;
  }
  .bc-companion-row {
    flex-direction: column-reverse;
    align-items: flex-end;
    gap: 8px;
    width: 100%;
  }
  .pos-bottom-left .bc-companion-row {
    flex-direction: column-reverse;
    align-items: flex-start;
  }
  .bc-stage-card {
    width: 116px;
    height: 140px;
  }
  .bc-stage-card.shape-circle {
    width: 110px;
    height: 110px;
  }
  .bc-root:is(.chat-is-open,.customizing) .bc-stage-card {
    width: 88px;
    height: 104px;
  }
  .bc-root:is(.chat-is-open,.customizing) .bc-stage-card.shape-circle {
    width: 84px;
    height: 84px;
  }
  .bc-chat {
    width: 100%;
    max-width: 100%;
    max-height: 52dvh;
  }
  .bc-btn {
    min-height: 34px;
    padding: 0 10px;
  }
  .bc-customizer { max-height: min(398px, calc(100dvh - 186px - env(safe-area-inset-bottom, 0px))); }
  .bc-look-fields select { font-size: 16px; }
}
@media (max-width: 640px) and (min-height: 600px) {
  .bc-root.customizing:not(.is-narrow-host) .bc-stage-card { width: 136px; height: 164px; }
  .bc-root.customizing:not(.is-narrow-host) .bc-stage-card.shape-circle { width: 136px; height: 136px; }
  .bc-customizer { max-height: min(398px, calc(100dvh - 250px - env(safe-area-inset-bottom, 0px))); }
}
@media (max-width: 360px) {
  .bc-controls { gap: 2px; }
  .bc-controls .bc-btn { padding: 0 6px; }
}


.bc-guide-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483001; overflow: hidden; }
.bc-guide-layer.is-contained { position: absolute; z-index: 21; }
.bc-guide-layer[hidden], .bc-guide-ring[hidden], .bc-guide-summary { display: none; }
.bc-guide-ring {
  position: absolute; pointer-events: none; border: 3px solid #544bd1;
  box-shadow: inset 0 0 0 2px #fff, 0 0 0 2px #fff, 0 0 12px #25207155;
}
.bc-root.is-guiding {
  position: fixed; right: auto; bottom: auto; left: var(--bc-guide-x); top: var(--bc-guide-y);
  z-index: 2147483002;
  width: min(260px, var(--bc-guide-width)); max-width: none; padding: 0;
  transition: left .23s ease-out, top .23s ease-out;
}
.bc-root.pos-contained.is-guiding { position: absolute; z-index: 22; }
.bc-root.is-guiding .bc-companion-row { display: block; max-width: none; width: 100%; }
.bc-root.is-guiding .bc-stage-wrap {
  display: flex; flex-direction: row; align-items: center; width: 100%; gap: 4px;
  padding: 5px 8px 5px 2px; color: #24253a; background: #fff; border: 1px solid #d6d1ed;
  border-radius: 15px; box-shadow: 0 6px 22px #17132d33;
}
.bc-root.avatar-on-right .bc-stage-wrap { flex-direction: row-reverse; padding: 5px 2px 5px 8px; }
.bc-root.is-guiding .bc-stage-slot { display: block; flex: 0 0 37%; }
.bc-root.is-guiding .bc-stage-wrap .bc-stage-card[role] {
  width: 100%; height: 107px; filter: none; transform: none; transition: none;
}
.bc-root.is-guiding :is(.bc-chat, .bc-controls, .bc-caption, .bc-unmute-prompt) { display: none; }
.bc-root.is-guiding .bc-guide-summary {
  display: grid; min-width: 0; flex: 1; gap: 3px;
  font: 13px/1.35 system-ui, sans-serif;
}
.bc-guide-label { font-weight: 700; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; color: #343056; }
.bc-guide-answer { max-height: 4.05em; overflow-y: auto; overflow-wrap: anywhere; overscroll-behavior: contain; }
.bc-guide-answer:empty { display: none; }
.bc-guide-back {
  justify-self: start; border: 0; border-radius: 5px; padding: 4px 0; background: transparent;
  color: #3f37a2; font: 650 12px/1.4 system-ui, sans-serif; cursor: pointer;
}
.bc-guide-back:hover { text-decoration: underline; }
.bc-tour-progress, .bc-tour-controls { display: none; }
.bc-root.is-touring { width: min(304px, var(--bc-guide-width)); transition: none; }
.bc-root.is-touring .bc-stage-slot { height: 120px; }
.bc-root.is-touring .bc-stage-wrap .bc-stage-card[role] { height: 100%; }
.bc-root.is-travelling .bc-stage-wrap .bc-stage-card[role] {
  transform: translate3d(var(--bc-walk-x, 0px), var(--bc-walk-y, 0px), 0);
  pointer-events: none; z-index: 1;
}
.bc-root.is-travelling .bc-guide-answer { visibility: hidden; }
.bc-root.is-travelling .bc-stage-wrap { background: transparent; border-color: transparent; box-shadow: none; }
.bc-root.is-travelling .bc-guide-summary { position: relative; isolation: isolate; }
.bc-root.is-travelling .bc-guide-summary::before {
  content: ""; position: absolute; z-index: -1; inset: -6px; background: #fff;
  border: 1px solid #d6d1ed; border-radius: 12px; box-shadow: 0 4px 16px #17132d22;
}
.bc-root.is-touring .bc-guide-back { display: none; }
.bc-root.is-touring .bc-tour-progress { display: block; color: #58516d; font: 600 11px/1.4 system-ui, sans-serif; }
.bc-root.is-touring .bc-tour-controls { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.bc-tour-controls button {
  min-height: 32px; padding: 3px 7px; border-radius: 6px; border: 1px solid #d6d1ed;
  background: white; color: #38325d; font: 600 12px/1.3 system-ui, sans-serif; cursor: pointer;
}
.bc-tour-controls .bc-tour-next:not(:disabled), .bc-tour-controls .bc-tour-next:disabled + .bc-tour-finish {
  background: #463baf; border-color: #463baf; color: white;
}
.bc-tour-controls button:disabled { opacity: .44; cursor: default; }
.bc-tour-controls button:focus-visible { outline: 2px solid #4239a9; outline-offset: 2px; }
@media (pointer: coarse), (max-width: 640px) {
  .bc-tour-controls button { min-width: 44px; min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) { .bc-root.is-guiding { transition: none; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
  }
}
`,vt={look:'<svg class="bc-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21a9 9 0 1 1 9-9c0 2.5-1.5 4-4 4h-2a1.5 1.5 0 0 0-1.3 2.3l.4.6C15 20.2 13.7 21 12 21Z"/><circle cx="7.5" cy="11" r=".8"/><circle cx="10" cy="7" r=".8"/><circle cx="15" cy="8" r=".8"/></svg>',play:'<svg class="bc-ic solid" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 4.8v14.4a.6.6 0 0 0 .92.5l11.3-7.2a.6.6 0 0 0 0-1L8.42 4.3a.6.6 0 0 0-.92.5z"/></svg>',stop:'<svg class="bc-ic solid" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.2"/></svg>',chat:'<svg class="bc-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>',volume:'<svg class="bc-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.8 5.2a9.5 9.5 0 0 1 0 13.6"/></svg>',muted:'<svg class="bc-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>',minus:'<svg class="bc-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',close:'<svg class="bc-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',send:'<svg class="bc-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>'},Xr={compact:{w:136,h:166,orb:126},standard:{w:172,h:210,orb:158},large:{w:216,h:262,orb:196}},pc=/(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[a-z]{2,}[^\s<>"']*|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d ().-]{6,}\d)/gi;function uc(e,t){let a=0;for(let s of t.matchAll(pc)){let n=s[0].replace(/[.,!?;:)]+$/,""),r="";if(/^https?:\/\//i.test(n))r=n;else if(/^www\./i.test(n))r=`https://${n}`;else if(n.includes("@"))r=`mailto:${n}`;else{let l=n.replace(/\D/g,"");(n.startsWith("+")||l.length>=9)&&(r=`tel:${n.replace(/[^\d+]/g,"")}`)}if(!r)continue;e.append(t.slice(a,s.index));let i=document.createElement("a");i.href=r,i.textContent=n,r.startsWith("http")&&(i.target="_blank",i.rel="noopener noreferrer"),e.append(i),a=s.index+n.length}e.append(t.slice(a))}async function Jr(e={},t={}){let a={name:"Aria",role:"Website Companion",company:"bot.computer",website:typeof location<"u"?location.origin:"https://bot.computer",greeting:"Hi! Welcome to our website! Ask me anything below.",position:"bottom-right",size:"standard",autoGreet:!1,eyeTracking:!0,showCaptions:!0,chatEnabled:!0,speechEnabled:!0,chatStartOpen:!1,allowVisitorCustomization:!1,baseBrain:!0,facts:{},rememberChat:!0,persona:null,wasmUrl:"./tts.wasm",aimlUrl:"",aimlXml:e.aimlUrl?"":Qo.concierge.xml,voice:{gender:"female",pitchHz:192,speed:1.05,expressiveness:1.06},avatar:{...zt},...e};a.avatar={...zt,...e.avatar||{}},a.persona=Wa(a.persona),a.persona&&e.greeting===void 0&&(a.greeting=Go(a.persona,a));let s=()=>a.persona?a.persona.mood:"",n=document.createElement("div");n.className="bot-computer-widget-host";let r=document.body;if((a.position==="inline"||a.position==="contained")&&a.container){let L=typeof a.container=="string"?document.querySelector(a.container):a.container;L&&(r=L)}r.appendChild(n);let i=n.attachShadow({mode:"open"}),l=document.createElement("style");l.textContent=hc,i.appendChild(l);let p=Xr[a.size]||Xr.standard,h=a.position==="bottom-left"?"pos-bottom-left":a.position==="inline"?"pos-inline":a.position==="contained"?`pos-contained ${a.align==="left"?"pos-bottom-left":""}`:"pos-bottom-right",c=document.createElement("div");c.className=`bc-root ${h}`,c.style.setProperty("--bc-w",`${p.w}px`),c.style.setProperty("--bc-h",`${p.h}px`),c.style.setProperty("--bc-orb",`${p.orb}px`),c.innerHTML=`
    <button type="button" class="bc-minimized-pill" part="pill">
      <span class="bc-pill-dot"></span>
      <span class="bc-pill-label"></span>
    </button>
    <div class="bc-companion-row">
      <section class="bc-chat">
        <header class="bc-chat-head">
          <div class="bc-chat-title">
            <strong class="bc-head-name"></strong>
            <span class="bc-head-status">Ready</span>
          </div>
          <button type="button" class="bc-chat-close" title="Close chat" aria-label="Close chat">${vt.close}</button>
        </header>
        <div class="bc-messages" role="log" aria-live="polite"></div>
        <div class="bc-chips"></div>
        <form class="bc-form">
          <input type="text" class="bc-input" placeholder="Ask a question\u2026" autocomplete="off" aria-label="Your question" />
          <button type="submit" class="bc-send" title="Send" aria-label="Send">${vt.send}</button>
        </form>
      </section>

      <section id="bc-look" class="bc-chat bc-customizer" aria-label="Customize avatar" hidden>
        <header class="bc-chat-head">
          <div class="bc-chat-title"><strong>Customize avatar</strong><span>Only your view changes</span></div>
          <button type="button" class="bc-chat-close bc-look-close" aria-label="Close customizer">${vt.close}</button>
        </header>
        <div class="bc-look-body">
          <div class="bc-look-fields"></div>
          <div class="bc-look-colors"></div>
        </div>
        <footer class="bc-look-footer">
          <button type="button" class="bc-look-reset">Restore original look</button>
          <button type="button" class="bc-btn accent bc-look-done">Done</button>
        </footer>
      </section>
      <div class="bc-stage-wrap">
        <div class="bc-caption" aria-live="off"></div>
        <div class="bc-stage-slot">
          <div class="bc-stage-card" role="button" tabindex="0">
            <canvas width="360" height="440"></canvas>
            <canvas class="bc-model" width="360" height="440" aria-hidden="true"></canvas>
            <div class="bc-unmute-prompt" hidden>Tap to hear</div>
          </div>
        </div>
        <div class="bc-guide-summary">
          <div role="status" aria-atomic="true"><span id="bc-tour-progress" class="bc-tour-progress"></span><strong id="bc-guide-label" class="bc-guide-label"></strong></div>
          <div id="bc-guide-answer" class="bc-guide-answer"></div>
          <button type="button" class="bc-guide-back" aria-describedby="bc-guide-label bc-guide-answer">\u2190 Back to chat</button>
          <div class="bc-tour-controls" role="group" aria-label="Tour navigation" aria-describedby="bc-tour-progress bc-guide-label bc-guide-answer">
            <button type="button" class="bc-tour-prev">Back</button>
            <button type="button" class="bc-tour-next">Next</button>
            <button type="button" class="bc-tour-finish">Finish</button>
          </div>
        </div>
        <div class="bc-controls">
          <button type="button" class="bc-btn bc-speak-btn" title="Speak the greeting">${vt.play}<span>Speak</span></button>
          <button type="button" class="bc-btn accent bc-ask-btn" title="Ask a question">${vt.chat}<span>Ask</span></button>
          <button type="button" class="bc-btn bc-look-toggle" aria-label="Customize avatar" title="Customize avatar" aria-controls="bc-look" aria-expanded="false" hidden>${vt.look}<span>Customize</span></button>
          <button type="button" class="bc-btn bc-mute-btn" title="Mute" aria-label="Mute" aria-pressed="false">${vt.volume}</button>
          <button type="button" class="bc-btn bc-min-btn" title="Minimize" aria-label="Minimize">${vt.minus}</button>
        </div>
      </div>
    </div>
  `,i.appendChild(c);let o=c.querySelector("canvas"),d=c.querySelector(".bc-model"),u=null,m=c.querySelector(".bc-stage-card"),g=c.querySelector(".bc-caption"),f=c.querySelector(".bc-unmute-prompt"),E=c.querySelector(".bc-chat"),y=c.querySelector(".bc-head-name"),w=c.querySelector(".bc-head-status"),k=c.querySelector(".bc-messages"),Y=c.querySelector(".bc-chips"),C=c.querySelector(".bc-form"),q=c.querySelector(".bc-input"),Q=c.querySelector(".bc-speak-btn"),de=c.querySelector(".bc-ask-btn"),D=c.querySelector(".bc-mute-btn"),M=c.querySelector(".bc-min-btn"),A=c.querySelector(".bc-chat-close"),I=c.querySelector(".bc-minimized-pill"),H=c.querySelector(".bc-pill-label"),W=c.querySelector(".bc-look-toggle"),V=c.querySelector(".bc-customizer"),ee=null,v=bn(a),P=a.avatar;function X(L,re=!1){V.hidden=!L,V.classList.toggle("open",L),c.classList.toggle("customizing",L),W.setAttribute("aria-expanded",String(L)),L?V.querySelector("select")?.focus({preventScroll:!0}):re&&W.focus({preventScroll:!0})}function oe(){let L=a.allowVisitorCustomization===!0;!L&&(V.contains(i.activeElement)||i.activeElement===W)&&(a.chatEnabled?de:m).focus({preventScroll:!0}),W.hidden=!L,L?ee?ee.setOwnerAvatar(a.avatar):ee=nr({panel:V,ownerAvatar:a.avatar,storageKey:t.preview?null:v,onChange:re=>{P=re}}):(X(!1),P=a.avatar)}function $(){return a.allowVisitorCustomization!==!0||Ye?!1:(he.end(),c.classList.remove("is-minimized"),X(!0),!0)}W.onclick=()=>{V.hidden?$():X(!1,!0)};for(let L of V.querySelectorAll(".bc-look-close, .bc-look-done"))L.onclick=()=>X(!1,!0);V.addEventListener("keydown",L=>{L.key==="Escape"&&(L.preventDefault(),X(!1,!0))}),oe();let ae="Ready",ue=L=>{Q.innerHTML=`${L?vt.stop:vt.play}<span>${L?"Stop":a.speechEnabled?"Speak":"Greet"}</span>`};function Ae(){let L=String(a.name||"Companion");y.textContent=a.role?`${L} \xB7 ${a.role}`:L,H.textContent=L,I.title=`Open ${L}`,E.setAttribute("aria-label",`Chat with ${L}`);let re=c.classList.contains("is-guiding");m.title=re?"Replay this answer":a.speechEnabled?`Click to hear ${L}`:`Show the greeting from ${L}`,m.setAttribute("aria-label",m.title)}let we=()=>{let L=a.avatar.stageShape==="circle"&&a.avatar.framing!=="cutout";m.classList.toggle("shape-circle",L)};Ae(),we(),a.speechEnabled||(D.style.display="none",Q.title="Show the greeting",ue(!1)),a.chatEnabled?a.chatStartOpen&&(E.classList.add("open"),c.classList.add("chat-is-open")):de.style.display="none";let ye=()=>{let L=a.facts&&typeof a.facts=="object"?a.facts:{},re={name:a.name,role:a.role,company:a.company,website:a.website};for(let{key:be}of Jo)re[be]=String(L[be]??"").trim();return re},Oe=new $a({botProps:ye(),baseXml:a.baseBrain!==!1?yo:"",persona:a.persona}),ce=()=>Oe.quickChips.map(L=>({label:L,query:L}));async function ve(){let L=a.aimlXml||"";if(!L&&a.aimlUrl)try{let re=await fetch(a.aimlUrl);re.ok&&(L=await re.text())}catch(re){console.warn("[bot.computer] Could not fetch AIML XML:",re)}if(L)try{Oe.loadXML(L)}catch(re){console.warn("[bot.computer] Invalid AIML XML:",re)}te(ce())}let Re=[];function ie(L,re){let be=document.createElement("div");return be.className=`bc-msg ${L}`,L==="bot"?uc(be,String(re)):be.textContent=re,k.appendChild(be),k.scrollTop=k.scrollHeight,Re.push({role:L,text:String(re)}),be}let x=a.rememberChat!==!1&&a.position!=="contained"&&!t.preview,fe=`bot-computer:chat:${String(a.sessionId||a.name||"bot").toLowerCase()}`;function ge(){if(x)try{sessionStorage.setItem(fe,JSON.stringify({v:1,transcript:Re.slice(-40),engine:Oe.exportSession(),open:E.classList.contains("open")}))}catch{}}function U(){if(!x)return!1;try{let L=JSON.parse(sessionStorage.getItem(fe)||"null");if(!L||L.v!==1||!Array.isArray(L.transcript)||!L.transcript.length)return!1;for(let re of L.transcript)re&&(re.role==="bot"||re.role==="user")&&typeof re.text=="string"&&ie(re.role,re.text);return Oe.importSession(L.engine),L.open&&a.chatEnabled&&(E.classList.add("open"),c.classList.add("chat-is-open")),!0}catch{return!1}}function te(L){Y.replaceChildren();for(let re of(L||[]).slice(0,5)){let be=typeof re=="string"?re:re.label,Ue=typeof re=="string"?re:re.query||re.label,Me=document.createElement("button");Me.type="button",Me.className="bc-chip",Me.textContent=be,Me.onclick=()=>ya(Ue,be),Y.appendChild(Me)}}let K=ys();Ha(K,s());let ne={nx:0,ny:0,active:!1},he=$r({root:c,stage:m,host:n,parent:r,position:a.position,anim:K,onModeChange:Ae,onReturn:()=>(E.classList.contains("open")?q:m).focus({preventScroll:!0}),onTourDepart:()=>{J(),ba(K,"rest"),La()},onTourStop:(L,re)=>{re&&(ie("bot",jn(L)||`[Show ${L.target}]`),ge()),Vt(L)},onTourEnd:()=>{J(),ba(K,"rest")}}),Z=null,j=null,me=null,Ee=null,ke=0,He=!1,Pe=!1,Ye=!1,Ge=0,Le=0,Ze=0,je=null,Ne=null,We=0,Xe=L=>{if(!a.eyeTracking||Ye)return;let re=o.getBoundingClientRect();if(!re.width||!re.height)return;let be=re.left+re.width*.5,Ue=re.top+re.height*.42;ne.nx=Math.max(-1,Math.min(1,(L.clientX-be)/Math.max(180,window.innerWidth*.35))),ne.ny=Math.max(-1,Math.min(1,(L.clientY-Ue)/Math.max(160,window.innerHeight*.35))),ne.active=!0};window.addEventListener("pointermove",Xe,{passive:!0});function J(){if(Ze++,me){me.onended=null;try{me.stop()}catch{}me=null}He=!1,Ee=null,dt="",Ne=null,We=0,Ha(K,s()),ue(!1),Z&&(w.textContent=ae)}let dt="",Ht=[],it=null;function Kt(L,re){if(!a.showCaptions||!L||!L.words||!L.words.length)return;if(E.classList.contains("open")){g.classList.remove("visible");return}if(it!==L){it=L,dt="";let Qe=String(L.text||"").split(/\s+/).filter(Boolean);Ht=(Qe.length===L.words.length?Qe:L.words.map(_e=>_e.word)).map(qn)}let be=0,Ue=-1;for(let Qe=0;Qe<L.words.length&&re>=L.words[Qe].start;Qe++)be=Qe,re<L.words[Qe].end&&(Ue=Qe);let Me=`${be}:${Ue}`;Me!==dt&&(dt=Me,g.classList.add("visible"),clearTimeout(Le),g.replaceChildren(),Ht.forEach((Qe,_e)=>{let mt=document.createElement(_e===Ue?"mark":"span");_e!==Ue&&(_e<be||_e===be&&Ue===-1)&&(mt.className="said"),mt.textContent=Qe,g.append(mt," ")}))}let Te;function ca(){return a.speechEnabled?(Te??(Te=cc({wasmUrl:a.wasmUrl,wasmBytes:t.wasmBytes,embeddedWasmGzBase64:t.embeddedWasmGzBase64||globalThis.__BOT_COMPUTER_EMBEDDED_WASM_GZ__,bindTTSFn:t.bindTTSFn}).then(({TTS:L})=>Ye?null:(Z=new L(a.voice||"female"),a.voice=Z.settings,Z)).catch(L=>(console.error("[bot.computer] TTS engine load error:",L),w.textContent="Text only (voice unavailable)",null))),Te):Promise.resolve(null)}function La(){let L=globalThis.AudioContext||globalThis.webkitAudioContext;a.speechEnabled&&!Pe&&L&&(j??(j=new L),j.state==="suspended"&&j.resume().catch(()=>{}))}async function Yt(L,{emote:re="",defaultEmote:be="",cues:Ue=null,cueWords:Me=0}={}){J();let Qe=Ze,_e=Ue?{speechText:String(L),cues:Ue,wordCount:Me}:Oo(L),mt=_e.cues.some(Zt=>Zt.type==="action"),ha=re||(mt?"":be);ha&&ba(K,ha);let $e=()=>{Ne=Ss(_e.cues),We=performance.now()},et=!!Jt(_e.speechText)||_e.cues.some(Zt=>Zt.sound);et&&La();let Ia=a.speechEnabled&&et&&!Pe?Z||await ca():null;if(Ye||Qe!==Ze)return;if(!Ia||Pe){$e(),!a.speechEnabled&&a.showCaptions&&et&&(g.textContent=Jt(_e.speechText),g.classList.add("visible"),clearTimeout(Le),Le=setTimeout(()=>g.classList.remove("visible"),Math.max(3500,Math.min(15e3,_e.wordCount*350))));return}if(!j){$e();return}if(j.state==="suspended")try{await j.resume()}catch{}if(Ye||Qe!==Ze)return;if(j.state==="suspended"){f.hidden=!1,$e();return}f.hidden=!0;let It=/\[[a-zA-Z_/]/.test(_e.speechText)?Ia.speakScript(_e.speechText):Ia.speak(_e.speechText);if(!It||!It.samples||!It.samples.length){$e();return}let Qa=j.createBuffer(1,It.samples.length,It.sampleRate);Qa.copyToChannel(It.samples,0),me=j.createBufferSource(),me.buffer=Qa,me.connect(j.destination),Ee=It,Ne=Is(It,_e.cues,_e.wordCount),We=0,ke=j.currentTime+.015,He=!0,ue(!0),w.textContent="Speaking",me.start(ke),me.onended=()=>{Ho(K,Ne,1/0),Ne=null,Ha(K,s()),He=!1,Ee=null,dt="",ue(!1),w.textContent=ae,Le=setTimeout(()=>g.classList.remove("visible"),1600)}}async function ya(L,re){let be=String(L||"").trim();if(!be)return;let Ue=m.getBoundingClientRect();V.hidden||X(!1),E.classList.contains("open")||(E.classList.add("open"),c.classList.add("chat-is-open"),g.classList.remove("visible")),ie("user",re||be);let Me=Oe.reply(be);je=Me;let Qe=Me.tour?.length?he.startTour(Me.tour,Ue):null;Qe||(ie("bot",jn(Me)),he.start(Me.showcase,Me.displayText||"")),te(Me.chips&&Me.chips.length?Me.chips:ce()),ge(),Qe||await Vt(Me)}async function Vt(L){J(),he.currentStop&&ba(K,"rest");let re=Ze;La(),await new Promise(be=>{requestAnimationFrame(()=>setTimeout(be,0)),setTimeout(be,80)}),!(Ye||re!==Ze)&&await Yt(L.speechText,{cues:L.cues,cueWords:L.cueWords})}let va=()=>{if(!K.guideTravel)if(He)J();else if(c.classList.contains("is-guiding")&&je){let L=he.currentStop||je;Yt(L.speechText,{cues:L.cues,cueWords:L.cueWords})}else Yt(a.greeting,{defaultEmote:"wave"})};m.onclick=va,m.onkeydown=L=>{(L.key==="Enter"||L.key===" ")&&(L.preventDefault(),va())},Q.onclick=va;let Ya=()=>{E.classList.remove("open"),c.classList.remove("chat-is-open"),ge()};de.onclick=()=>{let L=!V.hidden;L&&X(!1);let re=L||!E.classList.contains("open");E.classList.toggle("open",re),c.classList.toggle("chat-is-open",re),re&&(g.classList.remove("visible"),k.children.length||ie("bot",Jt(a.greeting)),q.focus({preventScroll:!0})),ge()},A.onclick=Ya,E.addEventListener("keydown",L=>{L.key==="Escape"&&(Ya(),de.focus())}),D.onclick=()=>{Pe=!Pe,D.innerHTML=Pe?vt.muted:vt.volume,D.title=Pe?"Unmute":"Mute",D.setAttribute("aria-label",D.title),D.setAttribute("aria-pressed",String(Pe)),Pe&&J()},M.onclick=()=>{J(),V.hidden||X(!1),c.classList.add("is-minimized"),I.focus({preventScroll:!0})},I.onclick=()=>{c.classList.remove("is-minimized"),M.focus({preventScroll:!0})},C.onsubmit=L=>{L.preventDefault();let re=q.value.trim();re&&(q.value="",Aa=0,ya(re))};let Aa=0,Ta={nx:0,ny:0,active:!0};q.addEventListener("input",()=>{let L=m.getBoundingClientRect(),re=q.getBoundingClientRect();if(!L.width||!re.width)return;let be=re.left+re.width/2-(L.left+L.width/2),Ue=re.top+re.height/2-(L.top+L.height*.42),Me=Math.hypot(be,Ue)||1;Ta.nx=be/Me*.8,Ta.ny=Ue/Me*.8,Aa=performance.now()+1500});let wt=null;if(["inline","contained"].includes(a.position)&&typeof ResizeObserver=="function"){let L=()=>{c.classList.toggle("is-narrow-host",r.clientWidth<=640),a.position==="contained"&&c.style.setProperty("--bc-host-h",`${r.clientHeight}px`)};L(),wt=new ResizeObserver(L),wt.observe(r)}let Ua=typeof IntersectionObserver!="function",To=typeof IntersectionObserver=="function"?new IntersectionObserver(([L])=>{Ua=L.isIntersecting}):null;To?.observe(m);function Ve(L){if(!Ye){if(!document.hidden&&!c.classList.contains("is-minimized")){let re=he.refresh(),be=Math.min(window.devicePixelRatio||1,2),Ue=Math.max(120,Math.floor((m.clientWidth||p.w)*be)),Me=Math.max(120,Math.floor((m.clientHeight||p.h)*be));(o.width!==Ue||o.height!==Me)&&(o.width=Ue,o.height=Me);let Qe=null;if(He&&Ee&&j){let _e=Math.max(0,j.currentTime-ke);Qe=bs(Ee,Math.min(_e,Ee.duration),a.voice?.pitchHz||160),Kt(Ee,_e),Ho(K,Ne,_e,L)}else Ne&&We&&(Ho(K,Ne,(performance.now()-We)/1e3,L),Ne.next>=Ne.items.length&&(Ne=null,We=0));if(Hs(K,L,Qe,re||(performance.now()<Aa?Ta:a.eyeTracking?ne:null),a.voice?.pitchHz||160),Ua||K.guideTravel){let _e=c.classList.contains("is-guiding"),mt=_e?{...P,framing:P.framing==="full"?"full":"half",stageShape:"cutout",bgStyle:"transparent"}:P,ha=K.guideTravel?.phase==="walk"?"full":mt.framing,$e={framing:ha,smoothFraming:_e,showVoiceWaves:!_e};a.renderMode==="2d"?(d.hidden=!0,wo(o.getContext("2d"),Ue,Me,ha===mt.framing?mt:{...mt,framing:ha},K,L,$e)):($e.force=d.hidden,d.hidden=!1,u??(u=new Co(d,o,{orbitControls:!1,view:"front"})),u.render(mt,K,L,$e))}}Ge=requestAnimationFrame(Ve)}}return await ve(),U(),(globalThis.requestIdleCallback||(L=>setTimeout(L,250)))(()=>{Ye||Oe.warmUp()}),a.chatEnabled&&a.chatStartOpen&&!k.children.length&&ie("bot",Jt(a.greeting)),Ge=requestAnimationFrame(Ve),a.autoGreet&&ca().then(()=>{!Ye&&!je&&!He&&Yt(a.greeting,{defaultEmote:"wave"})}),{hostEl:n,openCustomizer:$,say:(L,re="")=>Yt(L,{emote:re}),ask:L=>ya(L),stop:J,emote:(L,re)=>ba(K,L,re),sound(L,re={}){let be=String(L||"").trim().toLowerCase().replace(/[^a-z-]/g,"");if(!be)return Promise.resolve();let Ue=be;return re.intensity!==void 0&&(Ue+=` intensity=${String(re.intensity).replace(/[^\w.]/g,"")}`),re.length!==void 0&&(Ue+=` length=${String(re.length).replace(/[^\w.]/g,"")}`),re.durationMs>0&&(Ue+=` for=${(Number(re.durationMs)/1e3).toFixed(2)}s`),Yt(`[${Ue}]`)},mood:L=>Ha(K,L),clearChat(){he.end(),J(),je=null,k.replaceChildren(),Re.length=0,Oe.resetSession(),te(ce());try{sessionStorage.removeItem(fe)}catch{}},updateConfig(L={}){let re=JSON.stringify(ye()),be=["name","role","company"].some(Me=>L[Me]!==void 0&&L[Me]!==a[Me]);L.name!==void 0&&(a.name=L.name),L.role!==void 0&&(a.role=L.role),L.company!==void 0&&(a.company=L.company),L.facts!==void 0&&(a.facts={...L.facts||{}});let Ue=JSON.stringify(ye())!==re;if(L.greeting!==void 0&&(a.greeting=L.greeting),L.speechEnabled!==void 0&&a.speechEnabled!==!!L.speechEnabled&&(a.speechEnabled=!!L.speechEnabled,J(),D.style.display=a.speechEnabled?"":"none",Q.title=a.speechEnabled?"Speak the greeting":"Show the greeting",ue(!1)),L.renderMode!==void 0&&(a.renderMode=L.renderMode),L.eyeTracking!==void 0&&(a.eyeTracking=L.eyeTracking),L.showCaptions!==void 0&&(a.showCaptions=L.showCaptions),L.chatEnabled!==void 0&&(a.chatEnabled=L.chatEnabled,de.style.display=a.chatEnabled?"":"none",a.chatEnabled||(he.end(),E.classList.remove("open"),c.classList.remove("chat-is-open"))),L.avatar&&(a.avatar={...a.avatar,...L.avatar},we()),L.allowVisitorCustomization!==void 0&&(a.allowVisitorCustomization=L.allowVisitorCustomization===!0),be&&!a.sessionId&&(v=bn(a),ee=null),(be||L.avatar||L.allowVisitorCustomization!==void 0)&&oe(),L.voice)if(Z)try{a.voice=Z.configure(L.voice)}catch{}else if(typeof L.voice=="string"||L.voice.preset)a.voice=L.voice;else{let Me=typeof a.voice=="string"?{preset:a.voice}:a.voice;a.voice={...Me,...L.voice}}if(L.persona!==void 0&&(a.persona=Wa(L.persona),Oe.setPersona(a.persona),Ha(K,s())),L.baseBrain!==void 0&&!!L.baseBrain!=(a.baseBrain!==!1)){a.baseBrain=!!L.baseBrain;try{Oe.loadBaseXML(a.baseBrain?yo:"")}catch{}}if(Ue)try{Oe.setBotProps(ye())}catch{}if(L.aimlXml!==void 0&&L.aimlXml!==a.aimlXml){he.end(),a.aimlXml=L.aimlXml;try{Oe.loadXML(a.aimlXml),te(ce())}catch{}}Ae()},destroy(){if(Ye=!0,he.end(),cancelAnimationFrame(Ge),To?.disconnect(),u?.dispose(),J(),window.removeEventListener("pointermove",Xe),wt&&wt.disconnect(),Z)try{Z.free()}catch{}n.remove()}}}var dc=new TextEncoder,mc=new TextDecoder;function Qr(e){var y,w,k,Y,C,at,Jn,Qn,Zn;if(!e||!e.memory||typeof e.tts_new!="function")throw new Error("Invalid TTS WebAssembly exports object");let t=M=>{let A=dc.encode(String(M));if(A.length===0)return[0,0];let I=e.tts_alloc(A.length);return new Uint8Array(e.memory.buffer,I,A.length).set(A),[I,A.length]},a=()=>{let M=e.tts_json_len();if(!M)return"";let A=e.tts_json_ptr();return mc.decode(new Uint8Array(e.memory.buffer,A,M))},s=()=>JSON.parse(a()),n=(M,A)=>{let I=A();if(!I)return new Float32Array(0);let H=M();return new Float32Array(e.memory.buffer,H,I).slice()},r=()=>{let M=e.tts_bytes_len();if(!M)return new Uint8Array(0);let A=e.tts_bytes_ptr();return new Uint8Array(e.memory.buffer,A,M).slice()},i=M=>JSON.stringify(M,(A,I)=>typeof I=="number"&&!Number.isFinite(I)?"__TTS_NONFINITE__":I);e.tts_meta_json();let l=s(),p=null,h=((Date.now?Date.now():123456789)^1597463007)>>>0,c=()=>{if(typeof crypto<"u"&&typeof crypto.getRandomValues=="function"){let M=new Uint32Array(1);return crypto.getRandomValues(M),M[0]>>>0}return h=Math.imul(h,1664525)+1013904223>>>0,h},o=()=>{let M=s(),A={samples:n(e.tts_samples_ptr,e.tts_samples_len),sampleRate:M.sampleRate,duration:M.duration,text:M.text,ipa:M.ipa,words:M.words,phones:M.phones,visemes:n(e.tts_visemes_ptr,e.tts_visemes_len),visemeRate:l.visemeRate,visemeFields:l.visemeFields.slice(),acoustics:n(e.tts_acoustics_ptr,e.tts_acoustics_len),acousticFields:l.acousticFields.slice()};return M.segments&&(A.segments=M.segments),A},d=async(M,A)=>{let I=A?null:globalThis.AudioContext||globalThis.webkitAudioContext,H=A||(p??(p=I?new I:null));if(!H)throw new Error("Web Audio API (AudioContext) is not available in this environment");if(H.state==="suspended"&&await H.resume(),!M||!M.samples||M.samples.length===0)return{speech:M,stop(){},done:Promise.resolve(M)};let W=H.createBuffer(1,M.samples.length,M.sampleRate);W.copyToChannel(M.samples,0);let V=H.createBufferSource();V.buffer=W,V.connect(H.destination);let ee=new Promise(v=>{V.onended=()=>v(M)});return V.start(),{speech:M,source:V,stop(){try{V.stop()}catch{}},done:ee}},u=typeof FinalizationRegistry<"u"?new FinalizationRegistry(M=>{M>0&&e.tts_drop(M)}):null,m=typeof FinalizationRegistry<"u"?new FinalizationRegistry(M=>{M>0&&e.tts_stream_drop(M)}):null;class g{constructor(A,I,H){pa(this,y);pa(this,w);pa(this,k);Sa(this,y,A),Sa(this,w,I),Sa(this,k,H),m&&m.register(this,A,this)}read(A=4800){if(!ot(this,y))return new Float32Array(0);if(e.tts_stream_read(ot(this,y),Math.max(0,Math.floor(Number(A)||0)))<0)throw new Error(a());return n(e.tts_samples_ptr,e.tts_samples_len)}get done(){return!ot(this,y)||e.tts_stream_done(ot(this,y))!==0}get duration(){return ot(this,w).duration}get position(){return ot(this,y)?e.tts_stream_position(ot(this,y)):ot(this,w).duration}get sampleRate(){return ot(this,w).sampleRate}get text(){return ot(this,w).text}get ipa(){return ot(this,w).ipa}get words(){return ot(this,w).words.map(A=>({...A}))}get visemes(){return ot(this,k).slice()}free(){ot(this,y)&&(m&&m.unregister(this),e.tts_stream_drop(ot(this,y)),Sa(this,y,0))}}y=new WeakMap,w=new WeakMap,k=new WeakMap;class f{constructor(A){pa(this,C);pa(this,Y);let I=0,H=0;A!=null&&([I,H]=t(i(A)));let W=e.tts_new(I,H);if(W<0)throw new Error(a());Sa(this,Y,W),u&&u.register(this,W,this)}static presets(){return structuredClone(l.presets)}static vowelNames(){return l.vowelNames.slice()}static toneBandsHz(){return Float64Array.from(l.toneBandsHz)}static voiceIds(){return l.voiceIds.slice()}static styleNames(){return l.styleNames.slice()}static sounds(){return structuredClone(l.sounds)}static soundNames(){return l.sounds.map(A=>A.id)}static noteToHz(A){let[I,H]=t(String(A)),W=e.tts_note_to_hz(I,H);if(W<0)throw new Error(a());return W}static randomVoice(A){let I=A&&typeof A=="object"&&Number.isFinite(A.seed)?Math.abs(Math.trunc(A.seed))>>>0:c(),H=0,W=0;if(A!=null&&([H,W]=t(i(A))),e.tts_random_voice(I,H,W)<0)throw new Error(a());return s()}configure(A){let I=F(this,C,at).call(this);if(A==null)return this.settings;let[H,W]=t(i(A));if(e.tts_configure(I,H,W)<0)throw new Error(a());return s()}randomize(A){let I=F(this,C,at).call(this),H=A&&typeof A=="object"&&Number.isFinite(A.seed)?Math.abs(Math.trunc(A.seed))>>>0:c(),W=0,V=0;if(A!=null&&([W,V]=t(i(A))),e.tts_randomize(I,H,W,V)<0)throw new Error(a());return s()}registerVoice(A,I){let H=F(this,C,at).call(this);if(typeof A!="string"||!A.trim())throw new Error("voice name must be a non-empty string");let W=i({name:A,voice:I===void 0?this.settings:I}),[V,ee]=t(W);if(e.tts_register_voice(H,V,ee)<0)throw new Error(a());return s()}voices(){let A=F(this,C,at).call(this);if(e.tts_list_voices(A)<0)throw new Error(a());return s()}setGender(A){let I=F(this,C,at).call(this),[H,W]=t(String(A));if(e.tts_set_gender(I,H,W)<0)throw new Error(a())}get gender(){return this.settings.gender}get settings(){let A=F(this,C,at).call(this);if(e.tts_get_settings(A)<0)throw new Error(a());return s()}get sampleRate(){return l.sampleRate}speak(A){let I=F(this,C,at).call(this),[H,W]=t(String(A));if(e.tts_speak(I,H,W)<0)throw new Error(a());return o()}speakWav(A){let I=F(this,C,at).call(this),[H,W]=t(String(A));if(e.tts_speak_wav(I,H,W)<0)throw new Error(a());return r()}speakScript(A){let I=F(this,C,at).call(this),H=typeof A=="string"?A:Array.isArray(A)?i({__cues:A}):null;if(H===null)throw new Error("speakScript expects a script string or an array of cue objects");let[W,V]=t(H);if(e.tts_speak_script(I,W,V)<0)throw new Error(a());return o()}speakScriptWav(A){let I=F(this,C,at).call(this),H=typeof A=="string"?A:Array.isArray(A)?i({__cues:A}):null;if(H===null)throw new Error("speakScriptWav expects a script string or an array of cue objects");let[W,V]=t(H);if(e.tts_speak_script_wav(I,W,V)<0)throw new Error(a());return r()}sound(A,I){return this.speakScript(F(this,C,Jn).call(this,A,I))}soundWav(A,I){return this.speakScriptWav(F(this,C,Jn).call(this,A,I))}sing(A,I,H){let W=F(this,C,at).call(this),[V,ee]=t(F(this,C,Qn).call(this,A,I,H));if(e.tts_sing(W,V,ee)<0)throw new Error(a());return o()}singWav(A,I,H){let W=F(this,C,at).call(this),[V,ee]=t(F(this,C,Qn).call(this,A,I,H));if(e.tts_sing_wav(W,V,ee)<0)throw new Error(a());return r()}singChorus(A){let I=F(this,C,at).call(this),[H,W]=t(F(this,C,Zn).call(this,A));if(e.tts_sing_chorus(I,H,W)<0)throw new Error(a());return o()}singChorusWav(A){let I=F(this,C,at).call(this),[H,W]=t(F(this,C,Zn).call(this,A));if(e.tts_sing_chorus_wav(I,H,W)<0)throw new Error(a());return r()}async play(A,I){let H=/\[[a-zA-Z_/]/.test(String(A))?this.speakScript(String(A)):this.speak(String(A));return d(H,I)}async playScript(A,I){return d(this.speakScript(A),I)}async playSound(A,I,H){return d(this.sound(A,I),H)}async playSong(A,I,H,W){return d(this.sing(A,I,H),W)}async playChorus(A,I){return d(this.singChorus(A),I)}stream(A){let I=F(this,C,at).call(this),[H,W]=t(String(A)),V=e.tts_stream_new(I,H,W);if(V<0)throw new Error(a());let ee=s(),v=n(e.tts_visemes_ptr,e.tts_visemes_len);return new g(V,ee,v)}phonemize(A){let I=F(this,C,at).call(this),[H,W]=t(String(A));if(e.tts_phonemize(I,H,W)<0)throw new Error(a());return a()}arpabet(A){let I=F(this,C,at).call(this),[H,W]=t(String(A));if(e.tts_arpabet(I,H,W)<0)throw new Error(a());return a()}normalize(A){let I=F(this,C,at).call(this),[H,W]=t(String(A));if(e.tts_normalize(I,H,W)<0)throw new Error(a());return a()}addWord(A,I){let H=F(this,C,at).call(this),[W,V]=t(`${A}	${I}`);if(e.tts_add_word(H,W,V)<0)throw new Error(a())}loadDictionary(A){let I=F(this,C,at).call(this),[H,W]=t(String(A)),V=e.tts_load_dictionary(I,H,W);if(V<0)throw new Error(a());return V}free(){ot(this,Y)&&(u&&u.unregister(this),e.tts_drop(ot(this,Y)),Sa(this,Y,0))}}Y=new WeakMap,C=new WeakSet,at=function(){if(!ot(this,Y))throw new Error("TTS instance has been freed");return ot(this,Y)},Jn=function(A,I){if(typeof A!="string"||!A.trim())throw new Error('sound expects the name of a vocal sound, e.g. "laugh"');let H={sound:A};return I&&typeof I=="object"&&(I.intensity!==void 0&&(H.intensity=I.intensity),I.length!==void 0&&(H.length=I.length),I.durationMs!==void 0&&(H.durationMs=I.durationMs)),[H]},Qn=function(A,I,H){if(typeof A=="string"){if(I===void 0&&H===void 0)return A;let W={notes:A};return I!==void 0&&String(I).trim()!==""?W.lyrics=String(I):(delete W.notes,W.score=A),H!==void 0&&(W.bpm=H),i(W)}if(A&&typeof A=="object"&&!Array.isArray(A)){let W={...A};return I!==void 0&&W.lyrics===void 0&&(W.lyrics=I),H!==void 0&&W.bpm===void 0&&(W.bpm=H),i(W)}throw new Error("sing expects a score string or an options object { bpm, notes, lyrics, \u2026 }")},Zn=function(A){if(typeof A=="string")return A;if(Array.isArray(A))return i({parts:A});if(A&&typeof A=="object")return i(A);throw new Error("singChorus expects a chorus score string or `{ bpm, parts: [...] }`")};function E(M,A=l.sampleRate){let I=M instanceof Float32Array?M:Float32Array.from(M||[]),H=I.length?e.tts_alloc_f32(I.length):0;return I.length&&new Float32Array(e.memory.buffer,H,I.length).set(I),e.tts_encode_wav(H,I.length,Math.max(1e3,Math.floor(Number(A)||l.sampleRate))),r()}return{TTS:f,SpeechStream:g,encodeWav:E}}var Zr="1.5.0";var Zo=typeof document>"u"?null:document.currentScript,xn=globalThis.__BOT_COMPUTER_AUTO_CONFIG__,ei=globalThis.__BOT_COMPUTER_EMBEDDED_WASM_GZ__;xn&&delete globalThis.__BOT_COMPUTER_AUTO_CONFIG__;ei&&delete globalThis.__BOT_COMPUTER_EMBEDDED_WASM_GZ__;var Xa={version:Zr,mount(e={}){let t=e.wasmUrl||(Zo?.src?new URL("../vendor/tts/tts.wasm",Zo.src).href:"./tts.wasm");return Jr({...e,wasmUrl:t},{bindTTSFn:Qr,embeddedWasmGzBase64:ei})}};Object.assign(Xa,{AIMLEngine:$a,AVATAR_PRESETS:Os,AVATAR_ACTIONS:Es,STARTER_AIML_PACKS:Qo,BASE_AIML_XML:yo,BOT_FACTS:Jo,VOICE_SOUND_TAGS:zn,PERSONALITIES:Ra,randomPersona:cr,randomBotName:hr,personaGreeting:Go,parseSpeechCues:Oo});var ti=globalThis.BotComputer?.runtimes||Object.create(null);Xa.runtimes=ti;ti["bot-embed.js"]=Xa;globalThis.BotComputer=Xa;function xr(){if(xn)return Xa.mount(xn);if(!Zo)return;let e=Zo.dataset;if(e.nomount==="true"||e.manual==="true"||!["config","name","aiml","wasm","autostart","customize","renderMode","speech","chat"].some(a=>e[a]!==void 0))return;let t={};if(e.config)try{t=JSON.parse(e.config)}catch(a){console.warn("[bot.computer] Invalid JSON in data-config:",a)}for(let a of["name","role","company","greeting","position","size","renderMode"])e[a]&&(t[a]=e[a]);return e.wasm&&(t.wasmUrl=e.wasm),e.aiml&&(t.aimlUrl=e.aiml),e.customize!==void 0&&(t.allowVisitorCustomization=e.customize==="true"),e.chat!==void 0&&(t.chatEnabled=e.chat!=="false"),e.speech!==void 0&&(t.speechEnabled=e.speech!=="false"),e.autogreet!==void 0&&(t.autoGreet=e.autogreet==="true"),Xa.mount(t)}typeof document<"u"&&(document.readyState==="loading"?document.addEventListener("DOMContentLoaded",xr,{once:!0}):xr());})();
