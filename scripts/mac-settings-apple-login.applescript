-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录填表
-- 流程：先填「电子邮件或电话号码」→ 等待下方出现密码框 → 填密码 → 继续
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
	end tell
	return false
end isSidebarSearchField

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

on loginFormInputFields(targetW)
	set found to {}
	tell application "System Events"
		try
			repeat with e in entire contents of targetW
				if my isInputElement(e) then
					if not my isSidebarSearchField(e) then set end of found to e
				end if
			end repeat
		end try
		try
			repeat with e in entire contents of sheet 1 of targetW
				if my isInputElement(e) then
					if not my isSidebarSearchField(e) then set end of found to e
				end if
			end repeat
		end try
	end tell
	return found
end loginFormInputFields

on fieldMatchesMarkers(tf, markers)
	tell application "System Events"
		repeat with marker in markers
			try
				if description of tf contains marker then return true
			end try
			try
				if title of tf contains marker then return true
			end try
			try
				set ph to value of attribute "AXPlaceholderValue" of tf
				if ph contains marker then return true
			end try
		end repeat
	end tell
	return false
end fieldMatchesMarkers

on clickElementContaining(targetW, fragment)
	tell application "System Events"
		repeat with e in entire contents of targetW
			try
				if value of e contains fragment then
					click e
					return true
				end if
			end try
			try
				if name of e contains fragment then
					click e
					return true
				end if
			end try
		end repeat
	end tell
	return false
end clickElementContaining

on findEmailFieldInWindow(targetW)
	set markers to {"电子邮件或电话号码", "Email or phone", "Email or Phone", "电子邮件", "email"}
	set fields to my loginFormInputFields(targetW)
	repeat with tf in fields
		if my fieldMatchesMarkers(tf, markers) then return tf
	end repeat
	if (count of fields) > 0 then return item 1 of fields
	return missing value
end findEmailFieldInWindow

on findPasswordFieldInWindow(targetW, appleId)
	set markers to {"密码", "Password"}
	set fields to my loginFormInputFields(targetW)
	repeat with tf in fields
		if my fieldMatchesMarkers(tf, markers) then return tf
	end repeat
	if (count of fields) >= 2 then return item 2 of fields
	if (count of fields) = 1 then
		try
			tell application "System Events"
				set tf to item 1 of fields
				set v to value of tf
				if v is "" or v is not appleId then return tf
			end tell
		end try
	end if
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

on typeIntoFocusedField(textValue, useKeystroke)
	tell application "System Events"
		delay 0.2
		if useKeystroke then
			keystroke textValue
		else
			keystroke textValue
		end if
	end tell
end typeIntoFocusedField

on fillEmailInWindow(targetW, appleId)
	set tf to my findEmailFieldInWindow(targetW)
	if tf is not missing value then
		my typeIntoField(tf, appleId, false)
		return true
	end if
	if my clickElementContaining(targetW, "电子邮件或电话号码") then
		my typeIntoFocusedField(appleId, false)
		return true
	end if
	if my clickElementContaining(targetW, "电子邮件") then
		my typeIntoFocusedField(appleId, false)
		return true
	end if
	error "未找到邮箱输入框（电子邮件或电话号码）"
end fillEmailInWindow

on fillPasswordInWindow(targetW, appleId, applePassword)
	set tf to my findPasswordFieldInWindow(targetW, appleId)
	if tf is not missing value then
		my typeIntoField(tf, applePassword, true)
		return true
	end if
	if my clickElementContaining(targetW, "密码") then
		my typeIntoFocusedField(applePassword, true)
		return true
	end if
	if my clickElementContaining(targetW, "Password") then
		my typeIntoFocusedField(applePassword, true)
		return true
	end if
	error "未找到密码输入框"
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
	delay 2

	tell application "System Events"
		tell process "System Settings"
			set frontmost to true
			delay 0.5

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

			-- 阶段 1：填写邮箱（电子邮件或电话号码）
			my fillEmailInWindow(targetW, appleId)
			delay 1.5

			-- 阶段 2：等待账号下方出现密码框；若未出现则点「继续」后再等
			set passField to my waitForPasswordFieldInWindow(targetW, appleId, 6)
			if passField is missing value then
				if not my clickButtonNamedInWindow(targetW, {"Continue", "继续", "Next", "下一步"}) then
					key code 36
				end if
				delay 2.5
				set targetW to my findLoginWindow(it)
				set passField to my waitForPasswordFieldInWindow(targetW, appleId, 15)
			end if

			if passField is not missing value then
				my typeIntoField(passField, applePassword, true)
			else
				my fillPasswordInWindow(targetW, appleId, applePassword)
			end if
			my verifyPasswordNotInSearch(targetW, applePassword)

			delay 0.8
			if not my clickButtonNamedInWindow(targetW, {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}) then
				if not my clickButtonNamedInWindow(targetW, {"Continue", "继续", "Sign In", "登录"}) then
					key code 36
				end if
			end if
		end tell
	end tell

	return "ok"
end run
