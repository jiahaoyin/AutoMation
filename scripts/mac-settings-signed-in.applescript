#!/usr/bin/env osascript
-- macOS 15 (Sequoia): detect whether System Settings shows the signed-in
-- Apple Account home. Returns "yes" | "no".

on normalizedText(valueText)
	set textValue to valueText as text
	set textValue to my replaceText("\r", " ", textValue)
	set textValue to my replaceText("\n", " ", textValue)
	return textValue
end normalizedText

on replaceText(findText, replaceWith, sourceText)
	set AppleScript's text item delimiters to findText
	set textItems to every text item of sourceText
	set AppleScript's text item delimiters to replaceWith
	set rebuiltText to textItems as text
	set AppleScript's text item delimiters to ""
	return rebuiltText
end replaceText

on signedInEvidenceInTree(uiElement)
	-- Login fields can expose the account email as AXValue. They are explicitly
	-- excluded before any text is considered signed-in evidence.
	set loginInputIdentifiers to {"USERNAME_TEXT_FIELD", "PASSWORD_TEXT_FIELD"}
	set nodeName to ""
	set nodeDescription to ""
	set nodeValue to ""
	set nodeIdentifier to ""
	try
		set nodeName to (name of uiElement) as text
	end try
	try
		set nodeDescription to (description of uiElement) as text
	end try
	try
		set nodeValue to (value of uiElement) as text
	end try
	try
		set nodeIdentifier to (value of attribute "AXIdentifier" of uiElement) as text
	end try

	if nodeIdentifier is in loginInputIdentifiers then return false
	set markerText to my normalizedText(nodeName & " " & nodeDescription & " " & nodeValue)
	set hasAppleIDSettingsMarker to false
	ignoring case
		if nodeIdentifier contains "AppleIDSettings" then set hasAppleIDSettingsMarker to true
		if nodeIdentifier contains "com.apple.systempreferences" and nodeIdentifier contains "AppleID" then set hasAppleIDSettingsMarker to true
	end ignoring
	set hasAccountMarker to false
	ignoring case
		if markerText contains "apple account" then set hasAccountMarker to true
		if markerText contains "apple id" then set hasAccountMarker to true
	end ignoring
	if markerText contains "Apple账户" then set hasAccountMarker to true
	if markerText contains "Apple帐户" then set hasAccountMarker to true
	if markerText contains "Apple帳戶" then set hasAccountMarker to true
	if markerText contains "Apple帳號" then set hasAccountMarker to true

	set hasSignOutMarker to false
	ignoring case
		if markerText contains "Sign Out" then set hasSignOutMarker to true
		if markerText contains "Sign out" then set hasSignOutMarker to true
		if markerText contains "Log Out" then set hasSignOutMarker to true
	end ignoring
	if markerText contains "退出登录" then set hasSignOutMarker to true
	if markerText contains "退出账户" then set hasSignOutMarker to true
	if markerText contains "退出帐号" then set hasSignOutMarker to true
	if markerText contains "退出帳戶" then set hasSignOutMarker to true
	if markerText contains "退出帳號" then set hasSignOutMarker to true

	if hasAppleIDSettingsMarker and (hasAccountMarker or hasSignOutMarker) then return true

	try
		repeat with child in UI elements of uiElement
			if my signedInEvidenceInTree(child) then return true
		end repeat
	end try
	return false
end signedInEvidenceInTree

on run argv
	tell application "System Events"
		if not (exists process "System Settings") then
			try
				do shell script "open 'x-apple.systempreferences:com.apple.systempreferences.AppleIDSettings'"
				delay 2
			end try
		end if

		if not (exists process "System Settings") then return "no"

		tell process "System Settings"
			repeat with w in windows
				-- On macOS 15 AppleIDSettings exposes the account-home controls
				-- through nested AXOther nodes rather than direct window buttons.
				try
					if my signedInEvidenceInTree(w) then return "yes"
				end try
			end repeat
		end tell
	end tell
	return "no"
end run
