; Custom NSIS uninstaller hooks for ADSI Inverter Dashboard
; Prompts the user to optionally remove all application data on uninstall.

!macro customUnInstall
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Do you also want to remove all application data?$\r$\n$\r$\n\
This will permanently delete databases, archives, exports, and license files from:$\r$\n$\r$\n\
  - C:\ProgramData\InverterDashboard$\r$\n\
  - C:\ProgramData\ADSI-InverterDashboard$\r$\n\
  - C:\Logs\InverterDashboard$\r$\n$\r$\n\
Choose No to keep your data for a future reinstall." \
      IDYES removeAppData IDNO skipRemoveAppData

    removeAppData:
      ; Server data, hot DB, and monthly archives
      RMDir /r "C:\ProgramData\InverterDashboard"

      ; License state and mirror
      RMDir /r "C:\ProgramData\ADSI-InverterDashboard"

      ; Default export path
      RMDir /r "C:\Logs\InverterDashboard"

      ; Electron cache and user preferences
      RMDir /r "$APPDATA\ADSI Inverter Dashboard"
      RMDir /r "$APPDATA\inverter-dashboard"

      ; License registry key
      DeleteRegKey HKCU "Software\ADSI\InverterDashboard"

    skipRemoveAppData:
  ${EndIf}
!macroend
