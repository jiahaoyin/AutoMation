-- macOS 15 (Sequoia)：系统设置 → Apple Account 登录
-- 凭证：APPLE_SCRIPT_APPLE_ID、APPLE_SCRIPT_PASSWORD
-- v1.0.26：BFS 定位非搜索文本框填邮箱/密码；排除侧边栏「搜索文本栏」

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

			-- BFS 收集非搜索文本框（排除侧边栏「搜索文本栏」）
			set tfQueue to {targetW}
			set tfList to {}

			repeat 200 times
				if (count of tfQueue) is 0 then exit repeat
				set parentRef to item 1 of tfQueue
				set tfQueue to rest of tfQueue
				try
					set childCount to count of UI elements of parentRef
					repeat with ci from 1 to childCount
						set childEl to UI element ci of parentRef
						set c to ""
						set roleDesc to ""
						set desc to ""
						try
							set c to class of childEl as text
						end try
						try
							set roleDesc to value of attribute "AXRoleDescription" of childEl
						end try
						try
							set desc to description of childEl
						end try
						if desc is "" then
							try
								set desc to name of childEl
							end try
						end if
						if c is in {"text field", "text area", "combo box"} then
							set isSearch to false
							if roleDesc contains "搜索" then set isSearch to true
							if desc contains "搜索" then set isSearch to true
							if not isSearch then
								set end of tfList to childEl
							end if
						end if
						if c is in {"group", "scroll area", "split group", "tab group", "splitter group"} then
							set end of tfQueue to childEl
						end if
					end repeat
				end try
			end repeat

			if (count of tfList) is 0 then
				error "未找到登录邮箱输入框（BFS 无非搜索文本栏）"
			end if

			set emailField to item 1 of tfList
			set the clipboard to appleId

			-- 填入邮箱：点击目标框 → 粘贴（禁止 Tab，避免焦点跑到侧边栏搜索）
			try
				click emailField
			on error
				try
					perform action "AXRaise" of emailField
				end try
			end try
			delay 0.45
			try
				set focused of emailField to true
			end try
			delay 0.15
			try
				set value of emailField to appleId
			end try
			delay 0.25
			keystroke "a" using command down
			delay 0.08
			try
				keystroke "v" using command down
			on error errMsg number errNum
				if errNum is -1743 then
					error "缺少自动化权限 (-1743)：请在 系统设置 → 隐私与安全性 → 自动化 中允许 Terminal（或 Cursor）控制「系统设置」。"
				end if
				error "粘贴失败: " & errMsg & " (" & errNum & ")"
			end try
			delay 0.65

			-- 验证邮箱已填入同一文本框，或「继续」按钮已启用
			set emailFilled to false
			set fieldVal to ""
			try
				set fieldVal to value of emailField as text
			end try
			if fieldVal contains "@" then
				if fieldVal is appleId or fieldVal contains appleId or appleId contains fieldVal then
					set emailFilled to true
				end if
			end if
			if not emailFilled then
				try
					set fieldVal to description of emailField
					if fieldVal contains "@" and fieldVal contains appleId then
						set emailFilled to true
					end if
				end try
			end if
			if not emailFilled then
				repeat with btnName in {"Continue", "继续", "Sign In", "Sign in", "登录", "Next", "下一步"}
					try
						set b to button btnName of targetW
						try
							if enabled of b then set emailFilled to true
						end try
						try
							if value of attribute "AXEnabled" of b then set emailFilled to true
						end try
					end try
				end repeat
			end if

			if not emailFilled then
				error "邮箱未成功填入登录框 (-2700)。请在 隐私与安全性 → 自动化 中允许 Terminal/Cursor 控制「系统设置」。"
			end if

			delay 0.5

			-- 密码：优先第二个非搜索文本框；否则在邮箱框下方坐标点击（不用 Tab）
			set the clipboard to applePassword
			set passwordFilled to false
			set pwdField to missing value

			if (count of tfList) >= 2 then
				set pwdField to item 2 of tfList
			end if

			if pwdField is not missing value then
				try
					click pwdField
				on error
					try
						perform action "AXRaise" of pwdField
					end try
				end try
				delay 0.35
				try
					set focused of pwdField to true
				end try
				delay 0.1
				try
					set value of pwdField to applePassword
				end try
				delay 0.2
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
				delay 0.4
				set passwordFilled to true
			else
				set emailPos to position of emailField
				set emailSize to size of emailField
				set clickX to (item 1 of emailPos) + (item 1 of emailSize) / 2
				set clickY to (item 2 of emailPos) + (item 2 of emailSize) + 48
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
				delay 0.4
				set passwordFilled to true
			end if

			if not passwordFilled then
				error "密码未成功填入登录框"
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
