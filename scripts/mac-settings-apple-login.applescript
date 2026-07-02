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
			my clickSidebarAppleAccount(it)
			delay 1.2

			my clickButtonNamed(it, {"Sign In", "Sign in", "登录", "登入"})
			delay 1.5

			set filledUser to false
			set filledPass to false

			repeat with w in windows
				repeat with tf in text fields of w
					try
						if not filledUser then
							my typeIntoField(tf, appleId, false)
							set filledUser to true
						else if not filledPass then
							my typeIntoField(tf, applePassword, true)
							set filledPass to true
							exit repeat
						end if
					end try
				end repeat

				if not filledPass then
					repeat with stf in text fields of sheet 1 of w
						try
							if not filledUser then
								my typeIntoField(stf, appleId, false)
								set filledUser to true
							else
								my typeIntoField(stf, applePassword, true)
								set filledPass to true
								exit repeat
							end if
						end try
					end repeat
				end if

				if filledPass then exit repeat
			end repeat

			if not filledUser then
				error "未找到 Apple ID 输入框（请确认 macOS 15 系统设置已打开 Apple Account 登录界面）"
			end if

			delay 0.6
			my clickButtonNamed(it, {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"})
			if not my clickButtonNamed(it, {"Continue", "继续", "Sign In", "登录"}) then
				key code 36
			end if
		end tell
	end tell

	return "ok"
end run
