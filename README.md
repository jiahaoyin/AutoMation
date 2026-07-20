# Apple ID Automation (macOS)

鍦?**macOS 15 Sequoia** 涓婅嚜鍔ㄥ寲瀹屾垚 Apple ID 鐧诲綍涓庝俊鎭噰闆嗭細

1. **绯荤粺璁剧疆** 鈫?Apple Account 鑷姩濉〃锛堟墜鏈洪獙璇佺爜浜哄伐锛?
2. **Firefox** + ruyiPage 鈫?`account.apple.com` 鐧诲綍涓?2FA
3. 閲囬泦**濮撳悕銆佺敓鏃?*锛岃緭鍑烘姤鍛婁笌鎴浘

涓?[ChromeTest](https://github.com) 鎺㈤拡椤圭洰**瀹屽叏鐙珛**锛屾湰浠撳簱鍗曠嫭缁存姢銆?

## 蹇€熷紑濮?

```bash
./install.sh    # 鍓嶇疆绠＄悊鍛樻巿鏉冦€丳ython/Node 鑷姩瀹夎銆佽緟鍔╁姛鑳藉紩瀵?
./run.sh        # 缁堢杈撳叆璐﹀彿瀵嗙爜 鈫?鑷姩澶囦唤 .env 鈫?鎵ц娴佺▼
```

`./install.sh` 鍚姩鍚庝細绔嬪嵆璇锋眰涓€娆＄鐞嗗憳瀵嗙爜鎺堟潈銆傝嫢娌℃湁 Python 3.10+锛?
瀹夎鍣ㄤ細涓嬭浇 Python.org 瀹樻柟 Python 3.12.10 universal2 PKG锛屾牳瀵瑰浐瀹?
SHA-256 鍜?Python Software Foundation Developer ID 绛惧悕锛屽啀浠?root 绉佹湁鏆傚瓨
鐩綍瀹屾垚绯荤粺瀹夎骞剁户缁垱寤?`.runtime/ruyipage-venv`锛屾棤闇€閲嶆柊杩愯鑴氭湰銆?
绠＄悊鍛樺瘑鐮佷粎鐢辩郴缁?`/usr/bin/sudo` 璇诲彇锛涙棩甯歌繍琛?`./run.sh` 涓嶄細璇锋眰绠＄悊鍛樻巿鏉冦€?

## 鐜

- macOS 15锛堟帹鑽愶級
- Node.js 18+锛圼nodejs.org](https://nodejs.org) 鎴?`install.sh` 涓嬭浇瀹樻柟鍖咃級
- Python 3.10+锛坄install.sh` 鑷姩妫€娴嬶紱缂哄け鏃跺畨瑁呭凡楠岀鐨勫畼鏂?Python 3.12.10锛?
- Firefox锛圼mozilla.org/firefox](https://www.mozilla.org/firefox/)锛?
- 褰撳墠杩愯涓讳綋鐨勩€岃緟鍔╁姛鑳姐€嶆潈闄愶紙`install.sh` 浼氬紩瀵硷紱鏈湴閫氬父涓?Terminal / iTerm锛屽彈鐩戠潱楠屾敹涓?Codex / 鍘熺敓 helper锛?

Vision OCR 浣跨敤銆屽睆骞曚笌绯荤粺闊抽褰曞埗銆嶏紙Screen & System Audio Recording锛?
鏉冮檺锛岃繖鏄嚜鍔ㄥ彇鐮佺殑**蹇呴渶鏉冮檺**銆俙install.sh` 浼氬湪缂栬瘧 exact native helper 鍚?
绔嬪嵆璇锋眰骞剁‘璁ゆ巿鏉冿紱`run.sh` 涔熶細鍦?Firefox 鍚姩鍓嶅啀娆＄‘璁ゃ€傛湭鎺堟潈銆乭elper 涓嶅彲鐢?
鎴栨巿鏉冪姸鎬佹湭鐢熸晥鏃舵祦绋嬩細鍦ㄦ彁浜よ处鍙峰瘑鐮佸墠鍋滄锛屼笉浼氶檷绾т负闈欓粯璺宠繃 OCR銆傝嫢绯荤粺瑕佹眰
閲嶅惎杩愯涓讳綋锛岃鎸夋彁绀洪噸鏂版墦寮€褰撳墠缁堢鎴?Codex 鍚庨噸鏂拌繍琛?`./install.sh`銆?

## 瀹夎鏁呴殰鎺掓煡

- **瀹夎 ruyiPage 鏃跺嚭鐜?PyPI TLS 璇佷功閿欒**锛歚install.sh` 濮嬬粓淇濇寔 HTTPS 璇佷功鏍￠獙锛涗粎椤圭洰绠＄悊鐨?macOS 铏氭嫙鐜涓?pip 鏀寔 `truststore` 鏃朵紭鍏堜娇鐢ㄧ郴缁熶俊浠诲簱锛屾樉寮?`RUYIPAGE_PYTHON` 涓嶆壙璇鸿琛屼负銆傚澶勪簬浼佷笟浠ｇ悊鐜锛岃鍏堝皢浠ｇ悊鏍硅瘉涔﹀畨瑁呭埌 macOS 绯荤粺閽ュ寵涓诧紝鍐嶉噸鏂版墽琛?`./install.sh`銆?

## 鍛戒护

| 鍛戒护 | 璇存槑 |
|------|------|
| `./install.sh` | 鍓嶇疆鎺堟潈锛涜嚜鍔ㄥ畨瑁?Python/Node銆乺uyiPage锛屽苟纭杈呭姪鍔熻兘涓庡睆骞曞綍鍒?|
| `./run.sh` | 瀹屾暣娴佺▼ |
| `./run.sh --skip-mac` | 浠呮祻瑙堝櫒 |
| `./run.sh --skip-browser` | 浠呯郴缁熻缃?|
| `npm run check` | 鐜鑷 |
| `npm run test:browser-backend` | 娴忚鍣ㄥ悗绔€夋嫨閫昏緫娴嬭瘯 |
| `npm run test:ruyipage-protocol` | ruyipage JSONL 鍗忚鑷祴 |
| `npm run test:ruyipage-flow` | ruyiPage Python 娴佺▼涓庡畨鍏ㄨ竟鐣屾祴璇?|
| `npm run test:2fa-allow-unit` | Allow銆乸opup AX/OCR 涓庨殣绉?source-contract 娴嬭瘯 |
| `npm run test:2fa-sidecar` | popup 浼樺厛涓庣郴缁熻缃覆琛屽洖閫€娴嬭瘯 |
| `npm run test:2fa-settings-unit` | 鍙彇娑堢郴缁熻缃?helper 鐢熷懡鍛ㄦ湡娴嬭瘯 |
| `npm run test:account-browser-flow` | 娴忚鍣ㄨ繍琛屼笌 2FA collector 鐢熷懡鍛ㄦ湡娴嬭瘯 |
| `npm run test:python-bootstrap` | Python 鑷姩瀹夎涓庢彁鏉冨叆鍙ｅ悎鍚屾祴璇?|
| `npm run package` | 鏈湴鎵撳寘 `dist/`锛堜繚鐣?zip锛?|
| `npm run release` | patch+1 鈫?鎵撳寘 鈫?涓婁紶 GitHub Releases 鈫?娓呯悊鏈湴 `dist/` |

## 鍙戝竷涓庡垎鍙?

**鏈満鍙戝竷**锛堟墦鍖呬笂浼犺嚦 GitHub Releases锛屾湰鍦颁笉淇濈暀 zip锛夛細

```bash
npm run release
```

**鍏朵粬 Mac 鎷夊彇鏈€鏂扮増**锛堟棤闇€ clone 浠撳簱锛屼笅杞借В鍘嬪嵆鐢級锛?

```bash
# 鏂瑰紡涓€锛氫竴閿剼鏈紙鎺ㄨ崘锛?
curl -fsSL https://raw.githubusercontent.com/jiahaoyin/Apple-AutoMation/main/scripts/fetch-latest.sh | bash

# 鏂瑰紡浜岋細宸?clone 浠撳簱鏃?
./scripts/fetch-latest.sh

# 瑙ｅ帇鍚庤繘鍏ョ洰褰?
cd apple-id-automation-latest/apple-id-automation-*/
./install.sh && ./run.sh
```

鎴栨墜鍔ㄤ笅杞斤細[GitHub Releases](https://github.com/jiahaoyin/Apple-AutoMation/releases) 涓殑 `*-macos.zip`锛岃В鍘嬪悗 `./install.sh && ./run.sh`銆?

## 鏂囨。

- **[docs/PROJECT.md](docs/PROJECT.md)** 鈥?鏋舵瀯銆佹枃浠惰鏄庛€佹晠闅滄帓鏌ワ紙鏂颁細璇濆繀璇伙級
- **[docs/MAC_CODEX_HANDOFF.md](docs/MAC_CODEX_HANDOFF.md)** 鈥?Mac Codex 鏂颁細璇濅氦鎺ャ€佸綋鍓?2FA 鐘舵€佷笌鎵嬪伐鍙嶉娴佺▼
- **[docs/WINDOWS_MAC_CODEX.md](docs/WINDOWS_MAC_CODEX.md)** 鈥?Windows 璋冨害 Mac Codex 娴嬭瘯銆佽瘉鎹洖浼犱笌淇閲嶆祴

## 娴忚鍣ㄥ悗绔?

娴忚鍣ㄥ惎鍔ㄣ€佸鑸€侀〉闈㈣鍙栥€佹帴绠°€佽緭鍏ャ€佹埅鍥句笌鍏抽棴鍏ㄩ儴鐢?Python `ruyiPage` 瀹屾垚銆傞」鐩笉鍐嶅寘鍚?Node BiDi 鎴栧叾浠栭〉闈㈣嚜鍔ㄥ寲鍥為€€锛況uyiPage 鏈氨缁椂浼氭槑纭仠姝㈠苟鎻愮ず杩愯 `./install.sh`銆?

```bash
BROWSER_BACKEND=ruyipage          # 鍞竴鍚庣锛沘uto 浠呭吋瀹规棫 .env
RUYIPAGE_PYTHON=python3           # 鍙€夛紱榛樿浣跨敤 .runtime/ruyipage-venv
BROWSER_PROFILE_MODE=persistent   # persistent | fresh
RUYIPAGE_BACKEND_TIMEOUT_MS=720000
RUYIPAGE_KILL_GRACE_MS=5000
BROWSER_2FA_SETTINGS_AFTER_MS=30000
BROWSER_2FA_SETTINGS_FALLBACK=1
BROWSER_2FA_MANUAL_FALLBACK=1
BROWSER_2FA_POLL_MS=800
BROWSER_PRESERVE_ON_FAILURE=1  # direct runs keep Firefox open after a failure; set 0 to close it
# OTP is never printed.
```

## 2FA 鑾峰彇涓庢仮澶嶉『搴?

ruyiPage 濉ソ瀵嗙爜鍜屸€滆浣忚处鍙封€濆悗锛屼細鍏堥€氳繃 JSONL 瑕佹眰 Node 娓呯悊鏃ч獙璇佺爜绐椼€佽褰?`preparedAt` 骞跺惎鍔?popup watcher锛涙敹鍒?`2fa_prepared` 鍚庢墠鎻愪氦瀵嗙爜銆俙need_2fa` 涔嬪墠 watcher 鍙敤浜庡噯澶囥€佽瀵熷拰娓呯悊鏃х獥锛屼笉浼氭彁鍓嶇偣鍑?Allow銆佽鍙栧€欓€夌爜鎴栧惎鍔ㄧ郴缁熻缃€?

绗竴娆?`getCode` acquisition 鎵嶅惎鍔ㄤ弗鏍间覆琛岀殑鍙栫爜閾惧拰鍏变韩 240 绉掓湡闄愶紱濡傜綉椤垫槑纭嫆缁濈涓€浠ｉ獙璇佺爜锛岀浜屼唬娌跨敤鍚屼竴鏈熼檺涓?Settings 鎬婚绠楋紝涓嶄細閲嶆柊璁℃椂銆傞『搴忓浐瀹氬涓嬶細

1. 浠?ruyiPage 鍙戝嚭 `need_2fa` 璧凤紝popup watcher 鍏堝湪 30 绉掍富绐楀彛鍐呯敤 AX 浠庡凡楠岃瘉鐨?Apple 绯荤粺寮圭獥璇诲彇 `NNN NNN`銆侫X 娌℃湁鍚堟硶楠岃瘉鐮佹椂锛屾墠瀵瑰悓涓€涓彲淇?Apple window ID 鍋氬唴瀛?Vision OCR锛涜嫢璇?helper 鏈幏 AX 鎺堟潈锛屽垯浠呭湪 `need_2fa` 鍚庢寜 dedicated Apple authentication process 鐨?on-screen window ID 鍚姩鍚屼竴 OCR 鍏滃簳銆傚叏绐楀彧鎺ュ彈 `NNN NNN`锛涘彧鏈変腑蹇冭鍓彲鎺ュ彈杩炵画鍏綅锛岃€屼笖蹇呴』鍦ㄥ悓涓€ window ID 鐨勪袱娆＄嫭绔嬫崟鑾蜂腑淇濇寔涓€鑷淬€侽CR 涓嶇偣鍑汇€佷笉鍋氬叏灞忔悳绱€佷笉鍐欎复鏃?PNG銆?
2. 鑷姩鎴栦汉宸ョ‘璁?Allow 鍚庯紝popup AX/OCR 鍐嶈幏寰楅澶?30 绉掔獥鍙ｃ€傚彧瑕佽涓婚樁娈靛彇寰楁湁鏁堟柊鐮侊紝绯荤粺璁剧疆鍜岄殣钘忔墜杈撻兘涓嶄細鍚姩锛岄獙璇佺爜浼氱珛鍗充氦缁?ruyiPage銆?
3. popup 涓婚樁娈靛埌鏈熶粛鏃犳柊鐮侊紝鎵嶈繘鍏ョ郴缁熻缃洖閫€銆係ettings 鏈€澶氫袱娆★紝姣忔鏈€澶?60 绉掞紝涓ゆ涔嬮棿閫€閬?5 绉掞紱杩涘叆璇ラ樁娈靛悗涓嶅啀鎺ュ彈杩熷埌鐨?popup 鍊欓€夌爜銆?
4. 浠呭湪 Settings 鐨勬湁鐣屽皾璇曠粨鏉熷悗锛屼笖浠庣涓€娆?acquisition 璧峰凡杩囪嚦灏?90 绉掋€乻tdin/stdout 閮芥槸 TTY銆佹墜杈撴湭琚槑纭鐢ㄦ椂锛屾墠鏄剧ず鍥哄畾鎻愮ず骞堕殣钘忚鍙栧叚浣嶉獙璇佺爜銆傛墜杈撻粯璁ゅ惎鐢紱鍙湁 `BROWSER_2FA_MANUAL_FALLBACK=0` 鎵嶇鐢紝閰嶇疆绀轰緥涓殑 `=1` 鏄樉寮忓惎鐢ㄥ啓娉曘€?
5. 绗竴涓湪鍏跺綋鍓嶄覆琛岄樁娈靛唴鏍￠獙閫氳繃鐨勬柊鐮佺珛鍗充氦缁欑綉椤碉紱鍚庣画闃舵涓嶅啀鍚姩锛屽師鐢?helper 涓庡脊绐楀彧鍋氭湁鐣屽悗鍙版竻鐞嗐€傜涓€娆?acquisition 璧?240 绉掑埌鏈熷悗锛宺unner 娓呯悊 helper 涓庤繘绋嬬粍骞舵暣浣撳け璐ャ€?

Allow 鑷姩鍔ㄤ綔鏈€澶氬皾璇曚袱娆°€備袱娆￠兘鏈‘璁ゆ椂锛岀粓绔彧鎻愮ず鐢ㄦ埛鎵嬪姩鐐瑰嚮
鈥滃厑璁糕€濓紱popup 涓婚樁娈典細缁х画绛夊緟锛岀洿鍒颁富绐楀彛鍒版湡鍚庢墠鎸変笂杩伴『搴忓洖閫€銆傝嚜鍔ㄥ皾璇曞彧鏈夊湪鍚庣画
鍘熺敓鐘舵€佺‘璁?Allow 娑堝け鎴栭獙璇佺爜绐楀嚭鐜板悗鎵嶇畻鎴愬姛銆?

popup 璇诲埌骞舵牎楠屽叚浣嶉獙璇佺爜鍚庝細绔嬪嵆浜ょ粰缃戦〉娴佺▼锛涘叧闂師鐢熼獙璇佺爜绐楀彧鏄敖鍔涙竻鐞嗭紝
鍏抽棴澶辫触浼氫繚鐣欏浐瀹氬璁＄姸鎬佸拰缁堢鎻愮ず锛屼笉鑳藉啀闃诲楠岃瘉鐮佹彁浜ゃ€?

鏈€缁堝彂甯冨悎鍚屾渶澶氬厑璁镐袱浠ｉ獙璇佺爜銆俫eneration 宸蹭粠 ruyiPage 浜嬩欢缁?runner 鍜?
`account-browser-flow` 閫忎紶鍒?collector銆傚彧鏈夊彲淇?Apple 椤甸潰鏄庣‘鏄剧ず鑻辨枃銆佺畝涓垨
绻佷腑鐨勯獙璇佺爜閿欒銆佹棤鏁堟垨杩囨湡璇箟鏃讹紝鎵嶅彲璇锋眰绗簩浠ｏ紱绗簩浠ｉ噸鏂颁粠 popup 涓婚樁娈靛紑濮嬶紝
浣嗘部鐢ㄧ涓€浠ｇ殑 240 绉掓湡闄愪笌 Settings 涓ゆ鎬婚绠椼€傜涓€浠ｇ珛鍗宠繘鍏ュ叏灞€鎷掔粷闆嗗悎锛屾墍鏈?
鏉ユ簮閮戒笉寰楀啀娆¤繑鍥炪€俢aptcha銆佽处鍙烽攣瀹氭垨鏈煡鐧诲綍閿欒蹇呴』鍋滄锛屼笉鑳藉€熲€滄崲鐮佲€濈户缁皾璇曘€?

sidecar `onStatus` 宸叉帴鍏ュ灞傜粓绔紝鍙樉绀哄浐瀹氶樁娈垫彁绀猴紝鍖呮嫭 popup 涓婚樁娈点€丼ettings
绗?1/2 娆°€? 绉掗噸璇曘€佹墜鍔?Allow銆侀殣钘忔墜杈撱€丱CR 鏉冮檺缂哄け銆佽幏鑳滄潵婧愬拰 240 绉掕秴鏃躲€?
OTP is never printed to the terminal or written to `2fa-audit.jsonl`,
`report.json`, screenshots, or error text. Use fixed handoff states instead.
姝ｅ父鐘舵€佷笉浼氭彃鍏ュ師濮?AX/OCR/stderr 鎴栧畬鏁?Apple ID銆備富鎺?fresh Windows 楠岃瘉宸查€氳繃 Python
126/126銆乺uyipage flow銆乸rotocol銆乻idecar銆乤ccount-browser-flow銆丄llow 61/61銆?
permissions 鍜?release锛屽洓璺渶缁堜笓椤瑰瀹″潎涓?PASS銆傝璇佹嵁瑕嗙洊閫昏緫涓?source-contract锛屼笉浠ｈ〃 Swift 缂栬瘧銆?
TCC 鎴?macOS 15 鍘熺敓 UI 宸查獙鏀躲€?

## 鏉冮檺鍒嗗眰

- 娴忚鍣?2FA 鐨勩€岃緟鍔╁姛鑳姐€嶆鏌ュ拰鎻愮ず鐢辩幇鏈?`mac-2fa-popup-read.swift` 閫氳繃 `AXIsProcessTrusted()`銆乣AXIsProcessTrustedWithOptions(...)` 鍙?`--preflight-accessibility` / `--prompt-accessibility` 鍘熺敓瀹屾垚銆傛棫 AppleScript 2FA/Accessibility 鏉冮檺鎺㈤拡宸茬Щ闄ゃ€?
- `./run.sh --skip-mac` 鍙姹傚疄闄呰繍琛屼富浣撹幏寰椼€岃緟鍔╁姛鑳姐€嶆潈闄愶紝鐢ㄤ簬鍙楅檺 Apple popup/Settings AX helper锛涙湰鍦伴€氬父鏄?Terminal / iTerm锛屽彈鐩戠潱楠屾敹浼氭槑纭彁绀?Codex / 鍘熺敓 helper锛涗笉瑕佹眰 Terminal 鎺у埗 System Events 鎴栤€滅郴缁熻缃€濄€?
- 鍙湁鎵ц macOS鈥滅郴缁熻缃櫥褰?Apple Account鈥濋樁娈垫椂锛屾墠瑕佹眰銆岃嚜鍔ㄥ寲銆嶄腑鍏佽褰撳墠缁堢 App 鎺у埗鈥滅郴缁熻缃€濄€?
- Screen Recording 鏄?Vision OCR 鑷姩鍙栫爜鐨勭‖闂ㄦ銆俙install.sh` 缂栬瘧 `mac-2fa-popup-ocr` 鍚庝細璇锋眰骞剁‘璁ゃ€屽睆骞曚笌绯荤粺闊抽褰曞埗銆嶏紱`run.sh` 鍦?Firefox 鍚姩鍓嶅啀娆℃牎楠屻€傜己澶辨椂鍥哄畾涓?`screen_recording_missing` 骞跺仠姝紝涓嶄細鎻愪氦璐﹀彿瀵嗙爜銆傛櫘閫氳繍琛屽鐢?`install.sh` 缂栬瘧鍒?`scripts/bin` 鐨?helper锛涘彈鐩戠潱楠屾敹浣跨敤鍥哄畾鐨勭敤鎴风骇 helper 缂撳瓨锛屽彧鍦ㄦ簮鐮佸彉鍖栨椂鍘熷瓙閲嶇紪璇戯紝閬垮厤姣忚疆闅忔満璺緞瑙﹀彂鏂扮殑 TCC 韬唤銆?
- 鏉冮檺鍙樻洿鍚庡簲鎸?macOS 鎻愮ず閫€鍑哄苟閲嶆柊鎵撳紑缁堢锛屽啀寮€濮嬩笅涓€娆¤繍琛屻€?

## macOS 15 楠屾敹

Windows 鍙兘楠岃瘉 Node/Python 閫昏緫銆佸崗璁€佽娉曞拰 source-contract锛屼笉鑳芥浛浠?Swift
缂栬瘧鎴?macOS 15 鍘熺敓 UI 楠屾敹銆侻ac 娴嬭瘯鏈烘媺鍙栧悗杩愯锛?

```bash
./install.sh
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-ax-fill.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-sms-verification.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-click-allow.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-popup-read.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-2fa-popup-ocr.swift
/usr/bin/xcrun swiftc -typecheck scripts/swift/mac-settings-2fa-code.swift
npm run check
npm run test:python-bootstrap
npm run test:2fa-allow-unit
npm run test:2fa-sidecar
npm run test:2fa-settings
npm run test:2fa-settings-unit
npm run test:mac-settings-sms-verification
npm run test:account-browser-flow
npm run test:ruyipage-protocol
npm run test:ruyipage-flow
./run.sh --skip-mac
```

鐪熸満杩樺繀椤婚獙璇?Screen Recording 宸叉巿鏉冧互鍙婃湭鎺堟潈鏃?Firefox 涓嶅惎鍔ㄣ€佽嫳鏂?绠€涓?绻佷腑 popup銆?
Allow 涓ゆ涓婇檺涓庢墜鍔ㄦ帴绠°€乣need_2fa` 璧?30 绉?popup 涓荤獥鍙ｃ€丄llow 鍚庨澶?30 绉掋€?
Settings 涓ゆ涓茶鍥為€€銆丼ettings 缁撴潫鍚庝笖涓嶆棭浜庨娆?acquisition 90 绉掔殑闅愯棌鎵嬭緭銆?
涓や唬鍏变韩 240 绉掓湡闄愪笌 Settings 鎬婚绠楋紝浠ュ強鍙栨秷/杩熷埌寮圭獥娓呯悊銆傜粓绔€乣report.json` 鍜?
`2fa-audit.jsonl` 涓嶅緱鍑虹幇 OTP銆佸師濮?
AX/OCR/stderr銆佸畬鏁?Apple ID 鎴栬璇侀〉闈㈡鏂囷紱璁よ瘉澶辫触涓嶅緱淇濆瓨鍏ㄩ〉鎴浘锛孫CR
涓嶅緱鐣欎笅鍥剧墖鏂囦欢銆傚畬鏁?macOS 璁剧疆鐧诲綍鍙﹁浣跨敤 `./run.sh` 楠岃瘉 Automation 鏉冮檺銆?

## 瀹夊叏

- `.env` 鍚处鍙峰瘑鐮侊紝**鍕挎彁浜?git**
- `data/` 鍚?Firefox Profile 涓庢姤鍛婏紝娉ㄦ剰淇濈
- 鏁忔劅璁よ瘉澶辫触鍙繚鐣欏浐瀹氬け璐ュ師鍥犲拰鑴辨晱瀹夊叏瀹¤锛屼笉淇濆瓨璁よ瘉椤靛叏椤垫埅鍥?

## 鐗堟湰

褰撳墠 `package.json` 鐗堟湰鍗冲彂甯冪増鏈紱`npm run release` 榛樿 patch +1 鍚庝笂浼?GitHub Releases銆?

## Supervised Mac Settings SMS verification

In an explicitly supervised Mac GUI session, supply both APPLE_AUTOMATION_SMS_PHONE and APPLE_AUTOMATION_SMS_API_URL only through the runtime environment. The independent Mac Settings module matches the phone suffix, polls the private HTTPS SMS endpoint for up to two minutes, and writes a validated six-digit code through the native helper. It then provides five additional minutes of hidden terminal manual entry. Do not store the endpoint or token in .env, shell history, logs, reports, or screenshots. This does not alter browser 2FA.
