#!/usr/bin/env osascript
-- 分阶段 2FA 弹窗：dismiss_stale | pre_allow | read_code

on parseArgs(argv)
	set phase to "read_code"
	set timeoutSec to 6
	repeat with a in argv
		if a starts with "--phase=" then
			set phase to text ((offset of "=" in a) + 1) thru -1 of a
		else if a starts with "--timeout=" then
			set timeoutSec to (text ((offset of "=" in a) + 1) thru -1 of a) as integer
		end if
	end repeat
	return {phase, timeoutSec}
end parseArgs

on procNames()
	return {"FollowUpUI", "CoreAuthUI", "AuthenticationServicesAgent", "SecurityAgent", "UserNotificationCenter", "akd", "loginwindow"}
end procNames

on isSixDigits(txt)
	if (length of txt) is not 6 then return false
	repeat with i from 1 to 6
		if character i of txt is not in "0123456789" then return false
	end repeat
	return true
end isSixDigits

on digitsFromText(txt)
	if txt is missing value then return ""
	set s to txt as text
	set AppleScript's text item delimiters to {" ", "-", tab, return, character id 160}
	set parts to text items of s
	set AppleScript's text item delimiters to ""
	set joined to parts as text
	if my isSixDigits(joined) then return joined
	set onlyDigits to ""
	repeat with i from 1 to count of characters of s
		set ch to character i of s
		if ch is in "0123456789" then set onlyDigits to onlyDigits & ch
	end repeat
	if my isSixDigits(onlyDigits) then return onlyDigits
	return ""
end digitsFromText

on elText(el)
	try
		set v to value of el
		if v is not missing value and (v as text) is not "" then return v as text
	end try
	try
		set t to title of el
		if t is not missing value and (t as text) is not "" then return t as text
	end try
	try
		set d to description of el
		if d is not missing value and (d as text) is not "" then return d as text
	end try
	return ""
end elText

on blobFromRoot(root)
	set blob to ""
	tell application "System Events"
		my collectBlob(root, ref blob)
	end tell
	return blob
end blobFromRoot

on collectBlob(el, blobRef)
	try
		set tx to my elText(el)
		if tx is not "" then set blobRef to (blobRef & " " & tx) as text
	end try
	try
		repeat with child in (UI elements of el)
			my collectBlob(child, blobRef)
		end repeat
	end try
end collectBlob

-- 简化：深度遍历 static text
on blobDeep(root)
	set blob to ""
	tell application "System Events"
		try
			repeat with t in (every UI element of root whose role is "AXStaticText")
				set blob to blob & " " & (my elText(t))
			end repeat
		end try
		try
			repeat with t in (static texts of root)
				set blob to blob & " " & (my elText(t))
			end repeat
		end try
		try
			repeat with g in (groups of root)
				try
					repeat with t in (static texts of g)
						set blob to blob & " " & (my elText(t))
					end repeat
				end try
				try
					repeat with sg in (groups of g)
						repeat with t in (static texts of sg)
							set blob to blob & " " & (my elText(t))
						end repeat
					end repeat
				end try
			end repeat
		end try
		try
			repeat with el in (UI elements of root)
				set r to role of el
				if r is "AXGroup" or r is "group" then
					set blob to blob & " " & (my blobDeep(el))
				end if
			end repeat
		end try
	end tell
	return blob
end blobDeep

on hasCodeDisplayPrompt(blob)
	if blob contains "在网页上输入此验证码" then return true
	if blob contains "在网页上输入" and blob contains "验证码" then return true
	if blob contains "输入此验证码" then return true
	if blob contains "验证码以登录" then return true
	if blob contains "verification code on the web" then return true
	if blob contains "Enter this verification code" then return true
	return false
end hasCodeDisplayPrompt

on looksLikeAllowDialog(blob)
	if blob contains "正用于登录" and blob contains "新设备" then return true
	if blob contains "正被用于" and blob contains "登录" then return true
	if blob contains "不允许" and blob contains "允许" then return true
	if blob contains "Don't Allow" and blob contains "Allow" then return true
	if blob contains "trying to sign in" then return true
	return false
end looksLikeAllowDialog

end looksLikeAllowDialog

on looksLikeCodeDialog(blob)
	if my hasCodeDisplayPrompt(blob) then return true
	if blob contains "验证码以登录" then return true
	if blob contains "正用于登录" and blob contains "新设备" and (blob contains "完成" or blob contains "Done") then return true
	return false
end looksLikeCodeDialog

on looksLikeFormattedCode(txt)
	if txt is missing value then return false
	set s to txt as text
	if (length of s) < 7 or (length of s) > 12 then return false
	set d to my digitsFromText(s)
	if d is "" then return false
	if (length of s) is 7 then
		set c4 to character 4 of s
		if c4 is " " or c4 is (character id 160) then return true
	end if
	return false
end looksLikeFormattedCode

on findFormattedCodeInBlob(blob)
	set i to 1
	set maxI to (length of blob) - 6
	repeat while i ≤ maxI
		try
			set chunk to text i thru (i + 6) of blob
			if my looksLikeFormattedCode(chunk) then
				return {my digitsFromText(chunk), chunk}
			end if
		end try
		set i to i + 1
	end repeat
	return {"", ""}
end findFormattedCodeInBlob

on extractCodeDeep(el, depth)
	if depth > 24 then return {"", ""}
	set tx to my elText(el)
	if tx is not "" and my looksLikeFormattedCode(tx) then
		set c to my digitsFromText(tx)
		if c is not "" then return {c, tx}
	end if
	tell application "System Events"
		try
			repeat with child in (UI elements of el)
				set pair to my extractCodeDeep(child, depth + 1)
				if item 1 of pair is not "" then return pair
			end repeat
		end try
	end tell
	return {"", ""}
end extractCodeDeep

on extractCodeFromRoot(root)
	set blob to my blobDeep(root)
	set pair to my findFormattedCodeInBlob(blob)
	if item 1 of pair is not "" then return pair
	tell application "System Events"
		try
			repeat with el in (entire contents of root)
				set tx to my elText(el)
				if my looksLikeFormattedCode(tx) then
					return {my digitsFromText(tx), tx}
				end if
			end repeat
		end try
		set pair to my extractCodeDeep(root, 0)
		if item 1 of pair is not "" then return pair
		try
			repeat with t in (every UI element of root whose role is "AXStaticText")
				set tx to my elText(t)
				if my looksLikeFormattedCode(tx) then
					return {my digitsFromText(tx), tx}
				end if
			end repeat
		end try
		try
			repeat with t in (static texts of root)
				set tx to my elText(t)
				if my looksLikeFormattedCode(tx) then
					return {my digitsFromText(tx), tx}
				end if
			end repeat
		end try
		try
			repeat with g in (groups of root)
				repeat with t in (static texts of g)
					set tx to my elText(t)
					if my looksLikeFormattedCode(tx) then
						return {my digitsFromText(tx), tx}
					end if
				end repeat
			end repeat
		end try
	end tell
	return {"", ""}
end extractCodeFromRoot

on buttonName(b)
	try
		return name of b as text
	end try
	return ""
end buttonName

on clickAllowDeep(root)
	tell application "System Events"
		try
			repeat with b in (buttons of root)
				set bn to my buttonName(b)
				if bn is "允许" or bn is "Allow" then
					click b
					return true
				end if
				if bn contains "允许" and bn does not contain "不允许" and bn does not contain "Don't" then
					click b
					return true
				end if
			end repeat
		end try
		try
			repeat with el in (UI elements of root)
				if my clickAllowDeep(el) then return true
			end repeat
		end try
	end tell
	return false
end clickAllowDeep

on clickDoneDeep(root)
	tell application "System Events"
		try
			repeat with b in (buttons of root)
				set bn to my buttonName(b)
				if bn contains "完成" or bn is "Done" or bn is "OK" then
					click b
					return true
				end if
			end repeat
		end try
		try
			repeat with el in (UI elements of root)
				if my clickDoneDeep(el) then return true
			end repeat
		end try
	end tell
	return false
end clickDoneDeep

on clickRightAllow(root)
	tell application "System Events"
		set btnList to {}
		try
			repeat with b in (buttons of root)
				set end of btnList to b
			end repeat
		end try
		try
			repeat with el in (UI elements of root)
				try
					repeat with b in (buttons of el)
						set end of btnList to b
					end repeat
				end try
			end repeat
		end try
		if (count of btnList) is greater than or equal to 2 then
			click item (count of btnList) of btnList
			return true
		end if
	end tell
	return false
end clickRightAllow

on eachDialogRoot()
	set results to {}
	tell application "System Events"
		repeat with pn in my procNames()
			if exists process pn then
				tell process pn
					repeat with w in windows
						set end of results to {pn, w}
						try
							repeat with s in (sheets of w)
								set end of results to {pn, s}
							end repeat
						end try
					end repeat
				end tell
			end if
		end repeat
		repeat with procRef in (every process)
			set pn to name of procRef
			try
				tell procRef
					if (count of windows) is greater than 0 then
						repeat with w in windows
							set end of results to {pn, w}
							try
								repeat with s in (sheets of w)
									set end of results to {pn, s}
								end repeat
							end try
						end repeat
					end if
				end tell
			end try
		end repeat
	end tell
	return results
end eachDialogRoot

on jsonEscape(s)
	set s to s as text
	set AppleScript's text item delimiters to "\""
	set parts to text items of s
	set AppleScript's text item delimiters to "\\\""
	set s to parts as text
	set AppleScript's text item delimiters to ""
	return s
end jsonEscape

on emitJson(ok, code, action, source, raw)
	set c to code
	if c is missing value then set c to ""
	set a to action
	if a is missing value then set a to "none"
	set src to source
	if src is missing value then set src to ""
	set r to raw
	if r is missing value then set r to ""
	set okStr to "false"
	if ok then set okStr to "true"
	return "{\"ok\":" & okStr & ",\"code\":\"" & c & "\",\"action\":\"" & a & "\",\"source\":\"" & (my jsonEscape(src)) & "\",\"raw\":\"" & (my jsonEscape(r)) & "\"}"
end emitJson

on tryClickAllow(pn, root, blob)
	tell application "System Events"
		try
			set frontmost of process pn to true
		end try
	end tell
	delay 0.2
	if my looksLikeAllowDialog(blob) then
		tell application "System Events"
			tell process pn
				try
					keystroke return
					delay 0.35
					return true
				end try
			end tell
		end tell
		if my clickRightAllow(root) then return true
	end if
	if my clickAllowDeep(root) then return true
	return false
end tryClickAllow

on scanPhase(phase)
	set dialogs to my eachDialogRoot()
	repeat with itemRef in dialogs
		set pn to item 1 of itemRef
		set root to item 2 of itemRef
		set blob to my blobDeep(root)
		set codePair to my extractCodeFromRoot(root)
		set code to item 1 of codePair
		set raw to item 2 of codePair
		set hasPrompt to my hasCodeDisplayPrompt(blob)
		set isAllowDlg to my looksLikeAllowDialog(blob)
		set isCodeDlg to my looksLikeCodeDialog(blob)

		if phase is "dismiss_stale" then
			if hasPrompt or code is not "" then
				if my clickDoneDeep(root) then
					return my emitJson(true, code, "dismissed_stale", pn, raw)
				end if
			end if
		else if phase is "pre_allow" then
			if isCodeDlg then
				if code is not "" then
					return my emitJson(true, code, "clicked_allow", pn, raw)
				end if
				return my emitJson(true, "", "clicked_allow", pn, "")
			end if
			if hasPrompt or code is not "" then
				if my clickDoneDeep(root) then
					return my emitJson(true, code, "dismissed_stale", pn, raw)
				end if
			end if
			if isAllowDlg then
				if my tryClickAllow(pn, root, blob) then
					return my emitJson(true, "", "clicked_allow", pn, "")
				end if
			end if
		else if phase is "allow_return" then
			if isAllowDlg and not isCodeDlg then
				tell application "System Events"
					try
						set frontmost of process pn to true
						delay 0.15
						tell process pn
							keystroke return
						end tell
						delay 0.2
						return my emitJson(true, "", "clicked_allow", pn, "")
					end try
				end if
			end if
		else if phase is "read_code" then
			if code is not "" and (isCodeDlg or hasPrompt) then
				return my emitJson(true, code, "read_code", pn, raw)
			end if
		else if phase is "probe" then
			if (isCodeDlg or hasPrompt) and code is not "" then
				return my emitJson(true, code, "has_code_dialog", pn, raw)
			end if
			if isCodeDlg or hasPrompt then
				return my emitJson(true, "", "has_code_dialog", pn, "")
			end if
			if isAllowDlg and not hasPrompt then
				return my emitJson(true, "", "has_allow_dialog", pn, "")
			end if
		end if
	end repeat
	if phase is "probe" then
		return my emitJson(false, "", "idle", "", "")
	end if
	if phase is "pre_allow" then
		if my clickAllowViaReturnKey() then
			return my emitJson(true, "", "clicked_allow", "keystroke", "")
		end if
	end if
	return my emitJson(false, "", "none", "", "")
end scanPhase

on clickAllowViaReturnKey()
	tell application "System Events"
		repeat with procRef in (every process)
			try
				set pn to name of procRef
				tell procRef
					repeat with w in windows
						if my looksLikeAllowDialog(my blobDeep(w)) then
							set frontmost of procRef to true
							delay 0.2
							perform action "AXRaise" of w
							delay 0.1
							keystroke return
							return true
						end if
					end repeat
				end tell
			end try
		end repeat
	end tell
	return false
end clickAllowViaReturnKey

on run argv
	set parsed to my parseArgs(argv)
	set phase to item 1 of parsed
	set timeoutSec to item 2 of parsed
	set deadline to (current date) + timeoutSec
	repeat while (current date) < deadline
		set out to my scanPhase(phase)
		if out contains "\"ok\":true" then
			do shell script "printf %s\\n " & quoted form of out
			return out
		end if
		delay 0.25
	end repeat
	set out to my emitJson(false, "", "none", "", "")
	do shell script "printf %s\\n " & quoted form of out
	error "timeout" number -128
end run
