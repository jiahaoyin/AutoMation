-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录
-- 策略：主内容区输入框（排除侧边栏）| 邮箱 set value + keystroke | 密码 click/焦点 keystroke（禁止 Tab）
-- 凭证：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD

on loginPageMarkers()
	return {"一个账户", "电子邮件或电话号码", "Email or phone", "Email or Phone", "Sign in to your Apple", "尽享 Apple", "登录", "密码", "Password"}
end loginPageMarkers

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

on windowMatchesMarker(w, marker)
	tell application "System Events"
		try
			if name of w contains marker then return true
		end try
		try
			repeat with e in entire contents of w
				try
					if value of e contains marker then return true
				end try
				try
					if name of e contains marker then return true
				end try
			end repeat
		end try
	end tell
	return false
end windowMatchesMarker

on findLoginWindow(procRef)
	tell application "System Events"
		tell procRef
			set markers to my loginPageMarkers()
			repeat with w in windows
				repeat with marker in markers
					if my windowMatchesMarker(w, marker) then
						try
							set index of w to 1
						end try
						set frontmost to true
						return w
					end if
				end repeat
			end repeat
			if (count of windows) > 0 then
				set index of window 1 to 1
				return window 1
			end if
		end tell
	end tell
	return missing value
end findLoginWindow

on waitForLoginWindow(procRef, maxWaitSec)
	repeat maxWaitSec times
		set targetW to my findLoginWindow(procRef)
		if targetW is not missing value then
			repeat with marker in my loginPageMarkers()
				if my windowMatchesMarker(targetW, marker) then return targetW
			end repeat
		end if
		my openAppleAccountPane()
		delay 1
	end repeat
	return my findLoginWindow(procRef)
end waitForLoginWindow

on clickButtonNamedInWindow(targetW, buttonLabels)
	tell application "System Events"
		repeat with btnName in buttonLabels
			try
				set b to button btnName of targetW
				if enabled of b then
					click b
					return true
				end if
			end try
			try
				set b to first button of targetW whose name is btnName
				if enabled of b then
					click b
					return true
				end if
			end try
			try
				set b to button btnName of sheet 1 of targetW
				if enabled of b then
					click b
					return true
				end if
			end try
		end repeat
	end tell
	return false
end clickButtonNamedInWindow

on clickSidebarAppleAccount(procRef, targetW)
	tell application "System Events"
		tell procRef
			set sidebarLabels to {"Apple Account", "Apple 账户", "Apple ID", "Apple 账户与密码"}
			repeat with lbl in sidebarLabels
				try
					click static text lbl of scroll area 1 of group 1 of targetW
					return true
				on error
					try
						click UI element lbl of scroll area 1 of group 1 of targetW
						return true
					end try
				end try
			end repeat
		end tell
	end tell
	return false
end clickSidebarAppleAccount

on ensureSettingsFrontmost(procRef)
	tell application "System Settings" to activate
	delay 0.35
	tell application "System Events"
		tell procRef
			set frontmost to true
		end tell
	end tell
	delay 0.35
end ensureSettingsFrontmost

on elementClassName(e)
	try
		return class of e as text
	on error
		return ""
	end try
end elementClassName

on isInputElement(e)
	set c to my elementClassName(e)
	if c is in {"text field", "text area", "combo box"} then return true
	set desc to my elementDescription(e)
	if my textContainsAny(desc, {"电子邮件", "Email or", "email or", "phone number", "电话", "Phone"}) then return true
	if my textContainsAny(desc, {"密码", "Password"}) then return true
	return false
end isInputElement

on allInputFields(targetW)
	set found to {}
	tell application "System Events"
		try
			repeat with e in entire contents of targetW
				if my isInputElement(e) then set end of found to e
			end repeat
		end try
		try
			repeat with e in entire contents of sheet 1 of targetW
				if my isInputElement(e) then set end of found to e
			end repeat
		end try
	end tell
	return found
end allInputFields

on sidebarScrollArea(targetW)
	tell application "System Events"
		try
			return scroll area 1 of group 1 of targetW
		end try
	end tell
	return missing value
end sidebarScrollArea

-- 侧边栏搜索框是密码误入的根源；按 UI 结构排除，而非仅靠 description
on isInsideSidebar(e, targetW)
	set sidebar to my sidebarScrollArea(targetW)
	if sidebar is missing value then return false
	tell application "System Events"
		try
			repeat with se in entire contents of sidebar
				if se is e then return true
			end repeat
		end try
	end tell
	return false
end isInsideSidebar

on isSidebarSearchField(tf)
	if my textContainsAny(my elementDescription(tf), {"搜索", "Search", "search"}) then return true
	return false
end isSidebarSearchField

on elementDescription(e)
	tell application "System Events"
		set parts to {}
		try
			set end of parts to description of e
		end try
		try
			set end of parts to title of e
		end try
		try
			set end of parts to value of attribute "AXRoleDescription" of e
		end try
		try
			set end of parts to value of attribute "AXPlaceholderValue" of e
		end try
	end tell
	set merged to ""
	repeat with p in parts
		if p is not missing value and p is not "" then set merged to merged & p
	end repeat
	return merged
end elementDescription

on textContainsAny(textValue, markers)
	if textValue is missing value or textValue is "" then return false
	repeat with marker in markers
		if textValue contains marker then return true
	end repeat
	return false
end textContainsAny

-- 登录表单只在主内容区；侧边栏只有「搜索」
on mainPaneInputFieldsByPosition(targetW)
	set found to {}
	tell application "System Events"
		try
			set winPos to position of targetW
			set winSize to size of targetW
			set minX to (item 1 of winPos) + (item 1 of winSize) * 0.22
			repeat with tf in my allInputFields(targetW)
				try
					set fp to position of tf
					if (item 1 of fp) >= minX then set end of found to tf
				end try
			end repeat
		end try
	end tell
	return found
end mainPaneInputFieldsByPosition

on firstNonSearchField(targetW)
	repeat with tf in my allInputFields(targetW)
		if not my isSidebarSearchField(tf) then return tf
	end repeat
	return missing value
end firstNonSearchField

on nonSearchInputFields(targetW)
	set found to {}
	repeat with tf in my allInputFields(targetW)
		if not my isSidebarSearchField(tf) then set end of found to tf
	end repeat
	return found
end nonSearchInputFields

-- 结构排除 → 坐标排除 → 非搜索 → 全部（v1.0.7）
on resolveLoginInputFields(targetW)
	set fields to my mainPaneInputFields(targetW)
	if (count of fields) > 0 then return fields

	set fields to my mainPaneInputFieldsByPosition(targetW)
	if (count of fields) > 0 then return fields

	set fields to my nonSearchInputFields(targetW)
	if (count of fields) > 0 then return fields

	return my allInputFields(targetW)
end resolveLoginInputFields

on mainPaneInputFields(targetW)
	set found to {}
	repeat with tf in my allInputFields(targetW)
		if not my isInsideSidebar(tf, targetW) then set end of found to tf
	end repeat
	return found
end mainPaneInputFields

on fieldValue(tf)
	try
		tell application "System Events"
			return value of tf
		end tell
	on error
		return ""
	end try
end fieldValue

on fieldMatchesMarkers(tf, markers)
	tell application "System Events"
		repeat with marker in markers
			try
				if description of tf contains marker then return true
			end try
			try
				if title of tf contains marker then return true
			end try
		end repeat
	end tell
	return false
end fieldMatchesMarkers

on continueButtonEnabled(targetW)
	tell application "System Events"
		repeat with btnName in {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}
			try
				set b to button btnName of targetW
				if enabled of b then return true
			end try
			try
				set b to first button of targetW whose name is btnName
				if enabled of b then return true
			end try
		end repeat
	end tell
	return false
end continueButtonEnabled

on mainPaneContainsAppleId(targetW, appleId)
	repeat with tf in my resolveLoginInputFields(targetW)
		set v to my fieldValue(tf)
		if v contains appleId or v is appleId then return true
	end repeat
	repeat with tf in my nonSearchInputFields(targetW)
		set v to my fieldValue(tf)
		if v contains appleId or v is appleId then return true
	end repeat
	return false
end mainPaneContainsAppleId

on emailFillSucceeded(targetW, appleId)
	if my continueButtonEnabled(targetW) then return true
	if my mainPaneContainsAppleId(targetW, appleId) then return true
	return false
end emailFillSucceeded

on verifyEmailFilled(targetW, appleId)
	if not my emailFillSucceeded(targetW, appleId) then
		error "邮箱未成功填入登录框，请重试"
	end if
end verifyEmailFilled

on typeIntoField(tf, textValue, useKeystroke)
	if my isSidebarSearchField(tf) then error "拒绝向侧边栏搜索框输入"
	tell application "System Events"
		click tf
		delay 0.3
		try
			set value of tf to ""
		end try
		delay 0.12
		if useKeystroke then
			keystroke textValue
		else
			try
				set value of tf to textValue
			on error
				keystroke textValue
			end try
		end if
	end tell
end typeIntoField

on keystrokeIntoField(tf, textValue)
	if my isSidebarSearchField(tf) then error "拒绝向侧边栏搜索框输入"
	tell application "System Settings" to activate
	delay 0.25
	tell application "System Events"
		click tf
		delay 0.35
		try
			set value of tf to ""
		end try
		delay 0.1
		keystroke "a" using command down
		delay 0.08
		repeat with i from 1 to count of characters of textValue
			keystroke character i of textValue
			delay 0.015
		end repeat
	end tell
end keystrokeIntoField

on clickEmailFieldByMarker(targetW)
	tell application "System Events"
		repeat with e in entire contents of targetW
			set desc to my elementDescription(e)
			if my textContainsAny(desc, {"电子邮件", "Email or", "email or", "phone number", "电话"}) then
				try
					click e
					return true
				end try
			end if
			try
				if value of e is "电子邮件或电话号码" or value of e is "Email or Phone Number" then
					click e
					return true
				end if
			end try
		end repeat
	end tell
	return false
end clickEmailFieldByMarker

on clickEmailFieldByCoordinates(targetW)
	tell application "System Events"
		try
			set winPos to position of targetW
			set winSize to size of targetW
			set clickX to (item 1 of winPos) + (item 1 of winSize) * 0.55
			set clickY to (item 2 of winPos) + (item 2 of winSize) * 0.48
			click at {clickX, clickY}
			return true
		end try
	end tell
	return false
end clickEmailFieldByCoordinates

on fillEmailByClickAndType(procRef, targetW, appleId)
	my ensureSettingsFrontmost(procRef)
	set clicked to my clickEmailFieldByMarker(targetW)
	if not clicked then
		set clicked to my clickEmailFieldByCoordinates(targetW)
	end if
	if not clicked then error "未找到可点击的邮箱输入区域"
	delay 0.35
	tell application "System Events"
		keystroke "a" using command down
		delay 0.08
		repeat with i from 1 to count of characters of appleId
			keystroke character i of appleId
			delay 0.015
		end repeat
	end tell
end fillEmailByClickAndType

on pickEmailFieldFromList(fields, appleId)
	if (count of fields) = 0 then return missing value
	set emailField to item 1 of fields
	repeat with tf in fields
		if my fieldMatchesMarkers(tf, {"电子邮件", "Email", "phone", "电话", "Phone"}) then
			set emailField to tf
			exit repeat
		end if
	end repeat
	return emailField
end pickEmailFieldFromList

-- 阶段 1：v1.0.7 set value + keystroke；无 AX 字段时坐标/标记点击
on fillEmailInWindow(procRef, targetW, appleId)
	my ensureSettingsFrontmost(procRef)

	set fields to {}
	repeat 10 times
		set fields to my resolveLoginInputFields(targetW)
		if (count of fields) > 0 then exit repeat
		delay 0.4
	end repeat

	if (count of fields) > 0 then
		set emailField to my pickEmailFieldFromList(fields, appleId)
		my typeIntoField(emailField, appleId, false)
		delay 0.45
		if not my emailFillSucceeded(targetW, appleId) then
			my keystrokeIntoField(emailField, appleId)
			delay 0.7
		end if
	else
		my fillEmailByClickAndType(procRef, targetW, appleId)
		delay 0.7
	end if

	my verifyEmailFilled(targetW, appleId)
	return true
end fillEmailInWindow

on findPasswordFieldInMainPane(targetW, appleId)
	set fields to my resolveLoginInputFields(targetW)
	repeat with tf in fields
		if my fieldMatchesMarkers(tf, {"密码", "Password"}) then return tf
	end repeat
	if (count of fields) >= 2 then
		repeat with tf in fields
			if not my fieldMatchesMarkers(tf, {"电子邮件", "Email", "phone", "电话", "Phone"}) then
				set v to my fieldValue(tf)
				if v does not contain "@" and v is not appleId then return tf
			end if
		end repeat
		return item 2 of fields
	end if
	return missing value
end findPasswordFieldInMainPane

on waitForPasswordFieldInMainPane(targetW, appleId, maxWaitSec)
	repeat maxWaitSec times
		set pw to my findPasswordFieldInMainPane(targetW, appleId)
		if pw is not missing value then return pw
		if my windowMatchesMarker(targetW, "密码") or my windowMatchesMarker(targetW, "Password") then
			set pw to my findPasswordFieldInMainPane(targetW, appleId)
			if pw is not missing value then return pw
		end if
		delay 0.5
	end repeat
	return missing value
end waitForPasswordFieldInMainPane

-- 阶段 2：点击主内容区密码框 keystroke；找不到则利用邮箱后的系统焦点（禁止 Tab）
on fillPasswordInWindow(procRef, targetW, appleId, applePassword)
	my ensureSettingsFrontmost(procRef)

	set passField to my waitForPasswordFieldInMainPane(targetW, appleId, 12)
	if passField is not missing value then
		my keystrokeIntoField(passField, applePassword)
	else
		delay 0.5
		tell application "System Events" to keystroke applePassword
	end if

	my verifyPasswordNotInSearch(targetW, applePassword)
	return true
end fillPasswordInWindow

on searchFieldContains(targetW, textValue)
	tell application "System Events"
		repeat with e in entire contents of targetW
			if my isInputElement(e) and my isSidebarSearchField(e) then
				try
					if value of e contains textValue then return true
				end try
			end if
			if my isInputElement(e) and my isInsideSidebar(e, targetW) then
				try
					if value of e contains textValue then return true
				end try
			end if
		end repeat
	end tell
	return false
end searchFieldContains

on verifyPasswordNotInSearch(targetW, applePassword)
	if my searchFieldContains(targetW, applePassword) then
		error "密码被误填入侧边栏搜索框，请重试"
	end if
end verifyPasswordNotInSearch

on readCredentials()
	set appleId to system attribute "APPLE_SCRIPT_APPLE_ID"
	set applePassword to system attribute "APPLE_SCRIPT_PASSWORD"
	if appleId is missing value or appleId is "" then error "缺少 APPLE_SCRIPT_APPLE_ID"
	if applePassword is missing value or applePassword is "" then error "缺少 APPLE_SCRIPT_PASSWORD"
	return {appleId, applePassword}
end readCredentials

on run argv
	set creds to my readCredentials()
	set appleId to item 1 of creds
	set applePassword to item 2 of creds

	tell application "System Settings" to activate
	delay 0.5
	my openAppleAccountPane()
	delay 2.5

	tell application "System Events"
		tell process "System Settings"
			set frontmost to true
			delay 0.8

			set targetW to my waitForLoginWindow(it, 12)
			if targetW is missing value then
				error "未找到 Apple 登录窗口（系统设置可能仍停留在辅助功能页）"
			end if

			set hasLoginContent to false
			repeat with marker in my loginPageMarkers()
				if my windowMatchesMarker(targetW, marker) then
					set hasLoginContent to true
					exit repeat
				end if
			end repeat

			if not hasLoginContent then
				my clickSidebarAppleAccount(it, targetW)
				delay 1.2
				my clickButtonNamedInWindow(targetW, {"Sign In", "Sign in", "登录", "登入"})
				delay 2
				set targetW to my findLoginWindow(it)
			end if

			delay 1.2
			my fillEmailInWindow(it, targetW, appleId)
			delay 0.8
			my fillPasswordInWindow(it, targetW, appleId, applePassword)

			delay 0.5
			if not my clickButtonNamedInWindow(targetW, {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}) then
				key code 36
			end if
		end tell
	end tell

	return "ok"
end run
