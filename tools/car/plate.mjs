// 架空の金沢ナンバーの画像を作る(元のテクスチャと同じく上下に2枚並べた 1024×1024)
import sharp from 'sharp';
const G='#1d5a3a';
const plate=(y)=>`<g transform="translate(0,${y})">
<rect x="0" y="0" width="1024" height="512" fill="#f4f4ef"/>
<rect x="34" y="30" width="956" height="452" rx="34" fill="none" stroke="${G}" stroke-width="10"/>
<circle cx="250" cy="78" r="20" fill="#c9cbc6" stroke="#9a9c97" stroke-width="4"/><circle cx="774" cy="78" r="20" fill="#c9cbc6" stroke="#9a9c97" stroke-width="4"/>
<text x="292" y="180" font-family="IPAGothic" font-size="120" fill="${G}" textLength="440" lengthAdjust="spacingAndGlyphs" stroke="${G}" stroke-width="3">金沢 531</text>
<text x="140" y="390" font-family="IPAGothic" font-size="110" fill="${G}" text-anchor="middle">も</text>
<circle cx="330" cy="330" r="24" fill="${G}"/><circle cx="500" cy="330" r="24" fill="${G}"/>
<text x="600" y="440" font-family="IPAGothic" font-size="300" fill="${G}" stroke="${G}" stroke-width="10" textLength="340" lengthAdjust="spacingAndGlyphs">36</text>
</g>`;
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">${plate(0)}${plate(512)}</svg>`;
// 使い方: node plate.mjs 出力.png
await sharp(Buffer.from(svg)).png().toFile(process.argv[2] || 'plate.png');
