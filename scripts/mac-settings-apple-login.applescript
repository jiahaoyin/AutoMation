-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录填表
-- 凭证通过环境变量传入：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD

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

on clickButtonNamed(procRef, buttonLabels)
	tell application "System Events"
		tell procRef
			repeat with btnName in buttonLabels
				try
					click button btnName of window 1
					return true
				on error
					try
						click button btnName of sheet 1 of window 1
						return true
					end try
				end try
			end repeat
		end tell
	end tell
	return false
end clickButtonNamed

on clickSidebarAppleAccount(procRef)
	tell application "System Events"
		tell procRef
			set sidebarLabels to {"Apple Account", "Apple 账户", "Apple ID", "Apple 账户与密码"}
			repeat with lbl in sidebarLabels
				try
					click static text lbl of scroll area 1 of group 1 of window 1
					return true
				on error
					try
						click UI element lbl of scroll area 1 of group 1 of window 1
						return true
					end try
				end try
			end repeat
		end tell
	end tell
	return false
end clickSidebarAppleAccount

on typeIntoField(tf, textValue, useKeystroke)
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

on collectTextFieldsFromWindow(w)
	set collected to {}
	tell application "System Events"
		try
			set collected to text fields of w
		end try
		try
			set collected to collected & (text fields of sheet 1 of w)
		end try
	end tell
	return collected
end collectTextFieldsFromWindow

on findTextFields(procRef)
	set found to {}
	tell application "System Events"
		tell procRef
			repeat with w in windows
				set found to found & my collectTextFieldsFromWindow(w)
			end repeat
		end tell
	end tell
	return found
end findTextFields

on firstTextField(procRef)
	set fields to my findTextFields(procRef)
	if (count of fields) > 0 then return item 1 of fields
	return missing value
end firstTextField

on isSignInLandingVisible(procRef)
	return my firstTextField(procRef) is not missing value
end isSignInLandingVisible

on waitForTextField(procRef, maxWaitSec)
	repeat maxWaitSec times
		set tf to my firstTextField(procRef)
		if tf is not missing value then return tf
		delay 1
	end repeat
	return missing value
end waitForTextField

on waitForPasswordField(procRef, appleId, maxWaitSec)
	repeat maxWaitSec times
		set tf to my firstTextField(procRef)
		if tf is not missing value then
			try
				tell application "System Events"
					set v to value of tf
					if v is "" or v is not appleId then return tf
				end tell
			end try
		end if
		delay 1
	end repeat
	return missing value
end waitForPasswordField

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
	delay 1

	if not my openAppleAccountPane() then
		error "无法打开 Apple Account 设置页（macOS 15 Sequoia 深链失败）"
	end if
	delay 2.5

	tell application "System Events"
		tell process "System Settings"
			set frontmost to true
			delay 0.8

			-- 深链可能直接进入「登录」落地页（主窗口，无 sheet）
			if not my isSignInLandingVisible(it) then
				my clickSidebarAppleAccount(it)
				delay 1.2
				my clickButtonNamed(it, {"Sign In", "Sign in", "登录", "登入"})
				delay 1.5
			end if

			-- 阶段 1：填写邮箱并点「继续」
			set emailField to my waitForTextField(it, 10)
			if emailField is missing value then
				error "未找到 Apple ID 邮箱输入框（请确认系统设置已打开 Apple Account 登录界面）"
			end if

			my typeIntoField(emailField, appleId, false)
			delay 0.6
			if not my clickButtonNamed(it, {"Continue", "继续", "Next", "下一步"}) then
				key code 36
			end if
			delay 2

			-- 阶段 2：等待密码框出现并填写
			set passField to my waitForPasswordField(it, appleId, 15)
			if passField is missing value then
				error "未找到密码输入框（邮箱提交后未出现密码页）"
			end if

			my typeIntoField(passField, applePassword, true)
			delay 0.6
			if not my clickButtonNamed(it, {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}) then
				if not my clickButtonNamed(it, {"Continue", "继续", "Sign In", "登录"}) then
					key code 36
				end if
			end if
		end tell
	end tell

	return "ok"
end run
