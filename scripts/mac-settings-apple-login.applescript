-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录填表
-- 流程：先填邮箱 → 等待下方密码框 → 填密码 → 继续
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
				click button btnName of targetW
				return true
			end try
			try
				click (first button of targetW whose name is btnName)
				return true
			end try
			try
				click button btnName of sheet 1 of targetW
				return true
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

on elementClassName(e)
	try
		return class of e as text
	on error
		return ""
	end try
end elementClassName

on isInputElement(e)
	set c to my elementClassName(e)
	return c is in {"text field", "text area", "combo box"}
end isInputElement

-- 与 v1.0.7 一致：收集全部输入框（邮箱阶段靠遍历顺序 + 排除搜索）
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

on isSidebarSearchField(tf)
	tell application "System Events"
		try
			set d to description of tf
			if d contains "搜索" or d contains "Search" or d contains "search" then return true
		end try
		try
			set d to title of tf
			if d contains "搜索" or d contains "Search" or d contains "search" then return true
		end try
		try
			set d to value of attribute "AXRoleDescription" of tf
			if d contains "搜索" or d contains "Search" or d contains "search" then return true
		end try
		try
			set ph to value of attribute "AXPlaceholderValue" of tf
			if ph contains "搜索" or ph contains "Search" or ph contains "search" then return true
		end try
	end tell
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

on isEmailField(tf)
	if my isSidebarSearchField(tf) then return false
	return my textContainsAny(my elementDescription(tf), {"电子邮件", "Email", "email", "phone", "电话", "Phone"})
end isEmailField

on firstNonSearchField(targetW)
	set fields to my allInputFields(targetW)
	repeat with tf in fields
		if not my isSidebarSearchField(tf) then return tf
	end repeat
	return missing value
end firstNonSearchField

-- 按 description「电子邮件或电话号码」定位邮箱框（比遍历顺序更可靠）
on findEmailFieldInWindow(targetW)
	set fields to my allInputFields(targetW)
	repeat with tf in fields
		if my isEmailField(tf) then return tf
	end repeat
	return missing value
end findEmailFieldInWindow

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

on fieldLooksLikeEmail(tf, appleId)
	if my isEmailField(tf) then return true
	set v to my fieldValue(tf)
	if v contains "@" or v is appleId then return true
	return false
end fieldLooksLikeEmail

-- 邮箱下方的第二个非搜索框，通常是密码框（避免 Tab 进侧边栏搜索）
on secondNonSearchField(targetW)
	set fields to my allInputFields(targetW)
	set seenFirst to false
	repeat with tf in fields
		if not my isSidebarSearchField(tf) then
			if seenFirst then return tf
			set seenFirst to true
		end if
	end repeat
	return missing value
end secondNonSearchField

on findPasswordFieldInWindow(targetW, appleId)
	set fields to my allInputFields(targetW)
	repeat with tf in fields
		if not my isSidebarSearchField(tf) then
			if my fieldMatchesMarkers(tf, {"密码", "Password"}) then return tf
		end if
	end repeat

	set pw to my secondNonSearchField(targetW)
	if pw is not missing value then
		if not my fieldLooksLikeEmail(pw, appleId) then return pw
	end if

	repeat with tf in fields
		if not my isSidebarSearchField(tf) then
			if not my fieldLooksLikeEmail(tf, appleId) then return tf
		end if
	end repeat

	return missing value
end findPasswordFieldInWindow

on waitForPasswordFieldInWindow(targetW, appleId, maxWaitSec)
	repeat maxWaitSec times
		set pw to my findPasswordFieldInWindow(targetW, appleId)
		if pw is not missing value then return pw
		if my windowMatchesMarker(targetW, "密码") or my windowMatchesMarker(targetW, "Password") then
			set pw to my findPasswordFieldInWindow(targetW, appleId)
			if pw is not missing value then return pw
		end if
		delay 1
	end repeat
	return missing value
end waitForPasswordFieldInWindow

on emailFieldContains(targetW, appleId)
	set tf to my findEmailFieldInWindow(targetW)
	if tf is not missing value then
		set v to my fieldValue(tf)
		if v contains appleId or v is appleId then return true
	end if

	set tf to my firstNonSearchField(targetW)
	if tf is not missing value then
		set v to my fieldValue(tf)
		if v contains appleId or v is appleId then return true
	end if

	tell application "System Events"
		repeat with e in entire contents of targetW
			if my isInputElement(e) and not my isSidebarSearchField(e) then
				try
					set v to value of e
					if v contains appleId or v is appleId then return true
				end try
			end if
		end repeat
	end tell
	return false
end emailFieldContains

on verifyEmailFilled(targetW, appleId)
	if not my emailFieldContains(targetW, appleId) then
		error "邮箱未成功填入登录框，请重试"
	end if
end verifyEmailFilled

-- 点击邮箱输入区域后 keystroke（模拟人工输入，触发密码框）
on keystrokeIntoEmailField(tf, appleId)
	if my isSidebarSearchField(tf) then error "拒绝向侧边栏搜索框输入"
	tell application "System Settings" to activate
	tell application "System Events"
		click tf
		delay 0.35
		try
			set value of tf to ""
		end try
		delay 0.1
		keystroke "a" using command down
		delay 0.08
		keystroke appleId
	end tell
end keystrokeIntoEmailField

on clickEmailAreaInWindow(targetW)
	set emailLabels to {"电子邮件或电话号码", "Email or Phone Number", "Email or phone number"}
	if my clickInputLabelInWindow(targetW, emailLabels) then return true

	tell application "System Events"
		repeat with e in entire contents of targetW
			set desc to my elementDescription(e)
			if my textContainsAny(desc, {"电子邮件", "Email or", "email or", "phone number"}) then
				if my isInputElement(e) then
					click e
					return true
				end if
				try
					click e
					return true
				end try
			end if
		end repeat
	end tell
	return false
end clickEmailAreaInWindow

on clickInputLabelInWindow(targetW, labelTexts)
	tell application "System Events"
		repeat with lbl in labelTexts
			try
				click (first static text of targetW whose value is lbl)
				return true
			end try
			try
				repeat with e in entire contents of targetW
					try
						if value of e is lbl then
							click e
							return true
						end if
					end try
				end repeat
			end try
		end repeat
	end tell
	return false
end clickInputLabelInWindow

on typeIntoField(tf, textValue, useKeystroke)
	if my isSidebarSearchField(tf) then error "拒绝向侧边栏搜索框输入"
	tell application "System Events"
		click tf
		delay 0.25
		try
			set value of tf to ""
		end try
		delay 0.15
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

-- 邮箱：按 description 定位 → set value / keystroke 多策略（勿 Tab）
on fillEmailInWindow(procRef, targetW, appleId)
	set emailField to my findEmailFieldInWindow(targetW)
	if emailField is not missing value then
		my typeIntoField(emailField, appleId, false)
		delay 0.5
		if my emailFieldContains(targetW, appleId) then
			my keystrokeIntoEmailField(emailField, appleId)
			delay 0.6
		end if
	end if

	if not my emailFieldContains(targetW, appleId) then
		set tf to my firstNonSearchField(targetW)
		if tf is not missing value then
			my keystrokeIntoEmailField(tf, appleId)
			delay 0.6
		end if
	end if

	if not my emailFieldContains(targetW, appleId) then
		if my clickEmailAreaInWindow(targetW) then
			tell application "System Events"
				delay 0.3
				keystroke appleId
			end tell
			delay 0.6
		end if
	end if

	if not my emailFieldContains(targetW, appleId) then
		tell application "System Settings" to activate
		tell application "System Events"
			tell procRef
				set frontmost to true
			end tell
			try
				click targetW
			end try
			delay 0.25
			keystroke appleId
		end tell
		delay 0.6
	end if

	my verifyEmailFilled(targetW, appleId)
	return true
end fillEmailInWindow

-- 点击密码框输入（绝不 Tab；绝不向侧边栏搜索框输入）
on fillPasswordInWindow(targetW, appleId, applePassword)
	set passField to my findPasswordFieldInWindow(targetW, appleId)
	if passField is missing value then error "未找到密码输入框"
	my typeIntoField(passField, applePassword, true)
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

			-- 阶段 1：邮箱（set value + 校验）
			my fillEmailInWindow(it, targetW, appleId)
			delay 1.0

			-- 阶段 2：等待密码框 → 点击密码框输入（不要 Tab）
			set passField to my waitForPasswordFieldInWindow(targetW, appleId, 10)
			if passField is not missing value then
				my fillPasswordInWindow(targetW, appleId, applePassword)
			else
				-- 邮箱 keystroke 后焦点可能已在密码框，但 AX 树尚未暴露密码 field
				tell application "System Settings" to activate
				set frontmost to true
				delay 0.5
				keystroke applePassword
			end if
			my verifyPasswordNotInSearch(targetW, applePassword)

			-- 阶段 3：提交
			delay 0.5
			if not my clickButtonNamedInWindow(targetW, {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}) then
				if not my clickButtonNamedInWindow(targetW, {"Continue", "继续", "Sign In", "登录"}) then
					key code 36
				end if
			end if
		end tell
	end tell

	return "ok"
end run
