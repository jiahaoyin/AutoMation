-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录
-- 凭证：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD
-- v1.0.25：坐标粘贴为主路径；所有 UI 操作在 tell process 内联，禁止 AX 元素引用传给 handler

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

on run argv
	set creds to my readCredentials()
	set appleId to item 1 of creds
	set applePassword to item 2 of creds

	tell application "System Settings" to activate
	delay 0.5
	set paneOpened to system attribute "APPLE_SCRIPT_PANE_OPENED"
	if paneOpened is "1" then
		delay 1.5
	else
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
			delay 0.8

			-- 等待并定位登录窗口（按 window 索引，不用 loop 变量引用）
			set targetWinIndex to 1
			set markers to {"一个账户", "电子邮件或电话号码", "Email or phone", "Email or Phone", "Sign in to your Apple", "尽享 Apple", "登录", "密码", "Password"}
			repeat 12 times
				if (count of windows) > 0 then
					set winCount to count of windows
					repeat with wi from 1 to winCount
						set matched to false
						try
							set wName to name of window wi
							repeat with marker in markers
								if wName contains marker then
									set matched to true
									exit repeat
								end if
							end repeat
						end try
						if matched then
							set targetWinIndex to wi
							exit repeat
						end if
					end repeat
					if matched then exit repeat
				end if
				my openAppleAccountPane()
				delay 1
			end repeat

			if (count of windows) is 0 then
				error "未找到 Apple 登录窗口（系统设置可能仍停留在辅助功能页）"
			end if

			set targetW to window targetWinIndex
			try
				set index of targetW to 1
			end try
			set frontmost to true
			delay 0.5

			-- 若未在登录页，尝试点侧边栏 / 登录按钮
			set hasLoginContent to false
			try
				set wName to name of targetW
				repeat with marker in markers
					if wName contains marker then
						set hasLoginContent to true
						exit repeat
					end if
				end repeat
			end try

			if not hasLoginContent then
				set sidebarLabels to {"Apple Account", "Apple 账户", "Apple ID", "Apple 账户与密码"}
				repeat with lbl in sidebarLabels
					try
						click static text lbl of scroll area 1 of group 1 of targetW
						exit repeat
					on error
						try
							click UI element lbl of scroll area 1 of group 1 of targetW
							exit repeat
						end try
					end try
				end repeat
				delay 1.2
				repeat with btnName in {"Sign In", "Sign in", "登录", "登入"}
					try
						set b to button btnName of targetW
						if enabled of b then
							click b
							exit repeat
						end if
					end try
				end repeat
				delay 2
			end if

			tell application "System Settings" to activate
			delay 0.4
			set frontmost to true
			delay 0.6

			-- 坐标粘贴邮箱（主路径，全部内联）
			set the clipboard to appleId
			set winPos to position of targetW
			set winSize to size of targetW
			set baseX to item 1 of winPos
			set baseY to item 2 of winPos
			set w to item 1 of winSize
			set h to item 2 of winSize

			set emailFilled to false
			repeat with xFrac in {0.50, 0.52, 0.55, 0.58, 0.62, 0.65}
				repeat with yFrac in {0.36, 0.40, 0.44, 0.48, 0.52, 0.56, 0.60}
					set clickX to baseX + w * xFrac
					set clickY to baseY + h * yFrac
					tell application "System Settings" to activate
					set frontmost to true
					click at {clickX, clickY}
					delay 0.55
					keystroke "a" using command down
					delay 0.1
					try
						keystroke "v" using command down
					on error errMsg number errNum
						if errNum is -1743 then
							error "缺少自动化权限 (-1743)：请在 系统设置 → 隐私与安全性 → 自动化 中允许 Terminal（或 Cursor）控制「系统设置」。"
						end if
						error "粘贴失败: " & errMsg & " (" & errNum & ")"
					end try
					delay 0.75
					set btnReady to false
					repeat with btnName in {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}
						try
							set b to button btnName of targetW
							try
								if enabled of b then set btnReady to true
							end try
							try
								if value of attribute "AXEnabled" of b then set btnReady to true
							end try
						end try
					end repeat
					if btnReady then
						set emailFilled to true
						exit repeat
					end if
				end repeat
				if emailFilled then exit repeat
			end repeat

			if not emailFilled then
				error "邮箱未成功填入登录框 (-2700)。请在 隐私与安全性 → 自动化 中允许 Terminal/Cursor 控制「系统设置」。"
			end if

			delay 0.8

			-- 坐标粘贴密码（内联）
			set the clipboard to applePassword
			set winPos to position of targetW
			set winSize to size of targetW
			set baseX to item 1 of winPos
			set baseY to item 2 of winPos
			set w to item 1 of winSize
			set h to item 2 of winSize

			set passwordFilled to false
			repeat with yFrac in {0.52, 0.56, 0.60, 0.64, 0.68}
				set clickX to baseX + w * 0.58
				set clickY to baseY + h * yFrac
				tell application "System Settings" to activate
				set frontmost to true
				click at {clickX, clickY}
				delay 0.35
				keystroke "a" using command down
				delay 0.08
				try
					keystroke "v" using command down
				on error errMsg number errNum
					if errNum is -1743 then
						error "缺少自动化权限 (-1743)：请在 系统设置 → 隐私与安全性 → 自动化 中允许 Terminal（或 Cursor）控制「系统设置」。"
					end if
					error "密码粘贴失败: " & errMsg & " (" & errNum & ")"
				end try
				delay 0.45
				set passwordFilled to true
				exit repeat
			end repeat

			if not passwordFilled then
				keystroke "v" using command down
				delay 0.45
			end if

			delay 0.5

			-- 点击继续 / 登录
			set clicked to false
			repeat with btnName in {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}
				try
					set b to button btnName of targetW
					if enabled of b then
						click b
						set clicked to true
						exit repeat
					end if
				end try
				try
					set b to first button of targetW whose name is btnName
					if enabled of b then
						click b
						set clicked to true
						exit repeat
					end if
				end try
				try
					set b to button btnName of sheet 1 of targetW
					if enabled of b then
						click b
						set clicked to true
						exit repeat
					end if
				end try
			end repeat
			if not clicked then
				key code 36
			end if
		end tell
	end tell

	return "ok"
end run
