-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录
-- v1.0.28：按 AXIdentifier 精确定位登录控件；密码阶段重新解析动态 AX 路径
-- 凭证：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD

on logStep(n, msg)
	do shell script "echo " & quoted form of ("[step " & n & "] " & msg) & " 1>&2"
end logStep

on openAppleAccountPane()
	set urls to {"x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings", "x-apple.systempreferences:com.apple.preferences.AppleIDPref", "x-apple.systempreferences:com.apple.AccountSettings.AccountsSettingsExtension"}
	repeat with u in urls
		try
			do shell script "open " & quoted form of u
			return true
		end try
	end repeat
	return false
end openAppleAccountPane

on readCredentials()
	set appleId to system attribute "APPLE_SCRIPT_APPLE_ID"
	set applePassword to system attribute "APPLE_SCRIPT_PASSWORD"
	if appleId is missing value or appleId is "" then error "缺少 APPLE_SCRIPT_APPLE_ID"
	if applePassword is missing value or applePassword is "" then error "缺少 APPLE_SCRIPT_PASSWORD"
	return {appleId, applePassword}
end readCredentials

-- 在 parent 下按 BFS 找精确 AXIdentifier；不缓存跨状态转换的 AX 元素引用
-- 返回 {found, pathString}，pathString 如 "2/1/3"
using terms from application "System Events"
on isExpectedLoginControlKind(elementRef, wantedKind)
	try
		set roleValue to value of attribute "AXRole" of elementRef as text
		if wantedKind is "field" then
			if roleValue is "AXTextField" or roleValue is "AXSecureTextField" then return true
			set subroleValue to ""
			try
				set subroleValue to value of attribute "AXSubrole" of elementRef as text
			end try
			return subroleValue is "AXSecureTextField"
		end if
		if wantedKind is "button" then return roleValue is "AXButton"
	end try
	return false
end isExpectedLoginControlKind

on bfsUniqueElementWithIdentifier(parentRef, wantedIdentifier, wantedKind, maxDepth)
	set tfQueueEls to {parentRef}
	set tfQueuePaths to {""}
	set tfQueueDepths to {0}
	set queueIndex to 1
	set matchCount to 0
	set matchPath to ""
	repeat 600 times
		if queueIndex > (count of tfQueueEls) then exit repeat
		set curEl to item queueIndex of tfQueueEls
		set curPath to item queueIndex of tfQueuePaths
		set curDepth to item queueIndex of tfQueueDepths
		set queueIndex to queueIndex + 1
		try
			set childCount to count of UI elements of curEl
			repeat with ci from 1 to childCount
				set childEl to UI element ci of curEl
				set identifierValue to ""
				try
					set identifierValue to value of attribute "AXIdentifier" of childEl as text
				end try
				set childPath to curPath
				if childPath is "" then
					set childPath to (ci as text)
				else
					set childPath to curPath & "/" & (ci as text)
				end if
				if identifierValue is wantedIdentifier and my isExpectedLoginControlKind(childEl, wantedKind) then
					set matchCount to matchCount + 1
					if matchCount is 1 then set matchPath to childPath
				end if
				if curDepth < maxDepth then
					set end of tfQueueEls to childEl
					set end of tfQueuePaths to childPath
					set end of tfQueueDepths to (curDepth + 1)
				end if
			end repeat
		end try
	end repeat
	if matchCount is 1 then return {true, matchPath}
	return {false, ""}
end bfsUniqueElementWithIdentifier

on countElementsWithIdentifier(parentRef, wantedIdentifier, wantedKind, maxDepth)
	set tfQueueEls to {parentRef}
	set tfQueueDepths to {0}
	set queueIndex to 1
	set matchCount to 0
	repeat 600 times
		if queueIndex > (count of tfQueueEls) then exit repeat
		set curEl to item queueIndex of tfQueueEls
		set curDepth to item queueIndex of tfQueueDepths
		set queueIndex to queueIndex + 1
		try
			set childCount to count of UI elements of curEl
			repeat with ci from 1 to childCount
				set childEl to UI element ci of curEl
				set identifierValue to ""
				try
					set identifierValue to value of attribute "AXIdentifier" of childEl as text
				end try
				if identifierValue is wantedIdentifier and my isExpectedLoginControlKind(childEl, wantedKind) then
					set matchCount to matchCount + 1
				end if
				if curDepth < maxDepth then
					set end of tfQueueEls to childEl
					set end of tfQueueDepths to (curDepth + 1)
				end if
			end repeat
		end try
	end repeat
	return matchCount
end countElementsWithIdentifier

-- 每一轮从 live root 重新构建路径，避免 Continue 后 System Settings 重绘造成旧引用失效
on waitForIdentifierPath(parentRef, wantedIdentifier, wantedKind, maxAttempts, pauseSeconds)
	repeat maxAttempts times
		set identifierResult to my bfsUniqueElementWithIdentifier(parentRef, wantedIdentifier, wantedKind, 12)
		if item 1 of identifierResult then return identifierResult
		delay pauseSeconds
	end repeat
	return {false, ""}
end waitForIdentifierPath

on resolvePath(rootRef, pathString)
	if pathString is "" then return rootRef
	set el to rootRef
	set AppleScript's text item delimiters to "/"
	set idxList to text items of pathString
	set AppleScript's text item delimiters to ""
	repeat with idxStr in idxList
		set idxNum to idxStr as integer
		set el to UI element idxNum of el
	end repeat
	return el
end resolvePath

-- A stored child-index path is only a locator hint. Re-check its live leaf before every action.
on resolveIdentifierPath(rootRef, pathString, wantedIdentifier, wantedKind)
	try
		set el to my resolvePath(rootRef, pathString)
		set identifierValue to ""
		try
			set identifierValue to value of attribute "AXIdentifier" of el as text
		end try
		if identifierValue is wantedIdentifier and my isExpectedLoginControlKind(el, wantedKind) then return el
	end try
	return missing value
end resolveIdentifierPath

on fieldHasEnabledFocus(fieldEl)
	try
		if not (enabled of fieldEl) then return false
		if not (focused of fieldEl) then return false
		return true
	end try
	return false
end fieldHasEnabledFocus

on targetWindowIsFrontmost(targetW)
	try
		tell application "System Events"
			if not (frontmost of process "System Settings") then return false
			if not (focused of targetW) then return false
			if not (visible of targetW) then return false
			return true
		end tell
	end try
	return false
end targetWindowIsFrontmost

on targetWindowMatchesLoginState(targetW, wantedState)
	if not (my targetWindowIsFrontmost(targetW)) then return false
	set usernameCount to my countElementsWithIdentifier(targetW, "USERNAME_TEXT_FIELD", "field", 12)
	set passwordCount to my countElementsWithIdentifier(targetW, "PASSWORD_TEXT_FIELD", "field", 12)
	set buttonCount to my countElementsWithIdentifier(targetW, "LOGIN_BUTTON", "button", 12)
	if buttonCount is not 1 then return false
	if wantedState is "email" then return usernameCount is 1 and passwordCount is 0
	if wantedState is "password" then return usernameCount is less than or equal to 1 and passwordCount is 1
	return false
end targetWindowMatchesLoginState

on fillFieldAtPath(rootRef, pathString, textValue, verificationKind, wantedIdentifier)
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier, "field")
	if fieldEl is missing value then return {false, false}
	if not (my targetWindowIsFrontmost(rootRef)) then return {false, false}
	try
		if not (enabled of fieldEl) then return {false, false}
		click fieldEl
	on error
		try
			perform action "AXRaise" of fieldEl
		on error
			return {false, false}
		end try
	end try
	delay 0.35
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier, "field")
	if fieldEl is missing value then return {false, false}
	if not (my targetWindowIsFrontmost(rootRef)) then return {false, false}
	try
		if not (enabled of fieldEl) then return {false, false}
		set focused of fieldEl to true
	on error
		return {false, false}
	end try
	delay 0.12
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier, "field")
	if fieldEl is missing value then return {false, false}
	if not (my targetWindowIsFrontmost(rootRef)) then return {false, false}
	if not (my fieldHasEnabledFocus(fieldEl)) then return {false, false}

	keystroke "a" using command down
	delay 0.08
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier, "field")
	if fieldEl is missing value then return {false, false}
	if not (my targetWindowIsFrontmost(rootRef)) then return {false, false}
	if not (my fieldHasEnabledFocus(fieldEl)) then return {false, false}
	keystroke textValue
	delay 0.45
	set fieldEl to my resolveIdentifierPath(rootRef, pathString, wantedIdentifier, "field")
	if fieldEl is missing value then return {true, false}
	if not (my targetWindowIsFrontmost(rootRef)) then return {true, false}
	if not (my fieldHasEnabledFocus(fieldEl)) then return {true, false}
	set fieldVal to ""
	try
		set fieldVal to value of fieldEl as text
	end try
	if verificationKind is "email" then
		if fieldVal is textValue then return {true, true}
		return {true, false}
	end if
	if verificationKind is "password" then
		set minimumLength to count of textValue
		if minimumLength > 4 then set minimumLength to 4
		if (count of fieldVal) is greater than or equal to minimumLength then return {true, true}
		return {true, false}
	end if
	return {true, false}
end fillFieldAtPath

-- Re-find only when a re-render invalidated the saved path; never repeat a failed credential write.
on fillIdentifierField(wantedState, wantedIdentifier, textValue, verificationKind, maxAttempts, pauseSeconds)
	repeat maxAttempts times
		set targetW to my currentFrontmostLoginWindow(wantedState, 1, 0)
		if targetW is missing value then
			delay pauseSeconds
			next repeat
		end if
		set fieldResult to my bfsUniqueElementWithIdentifier(targetW, wantedIdentifier, "field", 12)
		if item 1 of fieldResult then
			set fillResult to my fillFieldAtPath(targetW, item 2 of fieldResult, textValue, verificationKind, wantedIdentifier)
			if item 1 of fillResult then return item 2 of fillResult
		end if
		delay pauseSeconds
	end repeat
	return false
end fillIdentifierField

-- LOGIN_BUTTON must be found by AXIdentifier and enabled before pressing it.
on clickLoginButton(wantedState, maxAttempts, pauseSeconds)
	repeat maxAttempts times
		set targetW to my currentFrontmostLoginWindow(wantedState, 1, 0)
		if targetW is missing value then
			delay pauseSeconds
			next repeat
		end if
		set buttonResult to my bfsUniqueElementWithIdentifier(targetW, "LOGIN_BUTTON", "button", 12)
		if item 1 of buttonResult then
			try
				set buttonEl to my resolveIdentifierPath(targetW, item 2 of buttonResult, "LOGIN_BUTTON", "button")
				if buttonEl is not missing value then
					if enabled of buttonEl then
						click buttonEl
						return true
					end if
				end if
			end try
		end if
		delay pauseSeconds
	end repeat
	return false
end clickLoginButton

on currentFrontmostLoginWindow(wantedState, maxAttempts, pauseSeconds)
	repeat maxAttempts times
		try
			tell application "System Events"
				if frontmost of process "System Settings" then
					repeat with candidateW in windows of process "System Settings"
						if my targetWindowMatchesLoginState(candidateW, wantedState) then return candidateW
					end repeat
				end if
			end tell
		end try
		delay pauseSeconds
	end repeat
	return missing value
end currentFrontmostLoginWindow

-- The WebView can be between email and password states when fallback begins.
-- Probe both states on every bounded poll instead of checking password only once.
on currentFrontmostLoginTarget(maxAttempts, pauseSeconds)
	repeat maxAttempts times
		set passwordW to my currentFrontmostLoginWindow("password", 1, 0)
		if passwordW is not missing value then return {"password", passwordW}
		set emailW to my currentFrontmostLoginWindow("email", 1, 0)
		if emailW is not missing value then return {"email", emailW}
		delay pauseSeconds
	end repeat
	return {"", missing value}
end currentFrontmostLoginTarget
end using terms from

on run argv
	set creds to my readCredentials()
	set appleId to item 1 of creds
	set applePassword to item 2 of creds

	my logStep(1, "activating System Settings")
	tell application "System Settings" to activate
	delay 0.8

	set paneOpened to system attribute "APPLE_SCRIPT_PANE_OPENED"
	if paneOpened is "1" then
		my logStep(2, "pane already opened by Node, waiting")
		delay 1.5
	else
		my logStep(2, "opening Apple Account pane")
		my openAppleAccountPane()
		delay 2.5
	end if

	tell application "System Events"
		tell process "System Settings"
			try
				set _n to count of windows
				set _cls to class of window 1 as text
				if _cls is "" then
					error "Automation partial: UI class empty (-1743/partial)" number -1743
				end if
			on error errMsg number errNum
				if errNum is -1743 then
					error "缺少自动化权限 (-1743)：请在 系统设置 → 隐私与安全性 → 自动化 中允许 Terminal（或 Cursor）控制「系统设置」。"
				end if
				error "System Events 无法访问系统设置: " & errMsg & " (" & errNum & ")"
			end try

			set frontmost to true
			delay 0.6
			my logStep(3, "System Settings frontmost, windows=" & (count of windows))

			set loginTarget to my currentFrontmostLoginTarget(18, 0.25)
			set loginState to item 1 of loginTarget
			set targetW to item 2 of loginTarget
			if targetW is missing value then
				error "未找到前台 Apple 登录邮箱页或密码页"
			end if
			if loginState is "email" then
				my logStep(4, "frontmost email login window resolved")

				-- 首屏的 Apple Account 输入框由 AXIdentifier 唯一标识，不能按文本框序号猜测。
				set emailResult to my waitForIdentifierPath(targetW, "USERNAME_TEXT_FIELD", "field", 12, 0.25)
				set emailFound to item 1 of emailResult
				if not emailFound then
					error "未找到登录邮箱输入框（USERNAME_TEXT_FIELD）"
				end if
				my logStep(5, "found USERNAME_TEXT_FIELD")

				set emailFilled to my fillIdentifierField("email", "USERNAME_TEXT_FIELD", appleId, "email", 3, 0.15)
				if not emailFilled then
					error "邮箱未成功填入登录框"
				end if
				my logStep(7, "email verified ok")

				delay 0.4
				set clickedCont to my clickLoginButton("email", 10, 0.2)
				if clickedCont then
					my logStep(8, "clicked Continue")
				else
					error "未找到或未启用登录继续按钮（LOGIN_BUTTON）"
				end if

				-- Continue 后窗口会重绘；每轮从当前窗口重新解析 PASSWORD_TEXT_FIELD 的路径。
				set targetW to my currentFrontmostLoginWindow("password", 18, 0.35)
			else
				my logStep(4, "frontmost password login window already active")
			end if
			if targetW is missing value then
				error "未在限定时间内找到密码输入框（PASSWORD_TEXT_FIELD）"
			end if
			set pwdResult to my waitForIdentifierPath(targetW, "PASSWORD_TEXT_FIELD", "field", 1, 0)
			set pwdFound to item 1 of pwdResult
			set pwdPath to item 2 of pwdResult

			if not pwdFound then
				error "未在限定时间内找到密码输入框（PASSWORD_TEXT_FIELD）"
			end if

			my logStep(9, "found PASSWORD_TEXT_FIELD")
			set passwordFilled to my fillIdentifierField("password", "PASSWORD_TEXT_FIELD", applePassword, "password", 3, 0.15)
			if not passwordFilled then
				error "密码未成功填入登录框"
			end if
			my logStep(10, "password verified ok")

			delay 0.4
			if my clickLoginButton("password", 10, 0.2) then
				my logStep(11, "clicked login/submit")
			else
				error "未找到或未启用登录提交按钮（LOGIN_BUTTON）"
			end if
		end tell
	end tell

	my logStep(12, "done ok")
	return "ok"
end run
