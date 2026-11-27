!ifndef MODELBRIDGE_CLI_PATH_INCLUDED
!define MODELBRIDGE_CLI_PATH_INCLUDED
!include "LogicLib.nsh"

; Tests redirect both keys and suppress the desktop environment notification.
!ifndef MB_CLI_ENV_REGISTRY_KEY
  !define MB_CLI_ENV_REGISTRY_KEY "Environment"
!endif
!ifndef MB_CLI_OWNER_REGISTRY_KEY
  !define MB_CLI_OWNER_REGISTRY_KEY "Software\ModelBridge"
!endif

Var MBPathValue
Var MBPathBefore
Var MBPathAfter
Var MBPathType
Var MBPathBeforeType
Var MBPathExists
Var MBPathBeforeExists
Var MBPathSafe
Var MBPathOwned
Var MBPathMissing
Var MBPathTarget
Var MBPathNormalized
Var MBPathEntry
Var MBPathIndex
Var MBPathStart
Var MBPathLength
Var MBPathMatches
Var MBPathRemoveStart
Var MBPathRemoveEnd
Var MBPathInstallEntry

!macro MBPathFunctions PREFIX
Function ${PREFIX}MBReadCliPath
  StrCpy $MBPathSafe 0
  StrCpy $MBPathExists 0
  StrCpy $MBPathValue ""
  StrCpy $MBPathType 2
  ; Query the unexpanded size before using any fixed-size NSIS string buffer.
  System::Call 'advapi32::RegGetValueW(p 0x80000001, w "${MB_CLI_ENV_REGISTRY_KEY}", w "Path", i 0x10000006, *i .r1, p 0, *i .r2) i .r0'
  ${If} $0 == 2
    StrCpy $MBPathSafe 1
    Return
  ${EndIf}
  IntOp $3 ${NSIS_MAX_STRLEN} * 2
  ${If} $0 != 0
  ${OrIf} $2 >= $3
    DetailPrint "ModelBridge left your user PATH unchanged: it could not be read safely."
    Return
  ${EndIf}
  StrCpy $MBPathType $1
  ClearErrors
  ReadRegStr $MBPathValue HKCU "${MB_CLI_ENV_REGISTRY_KEY}" "Path"
  ${If} ${Errors}
    DetailPrint "ModelBridge left your user PATH unchanged: reading it failed."
    Return
  ${EndIf}
  StrCpy $MBPathExists 1
  StrCpy $MBPathSafe 1
FunctionEnd

Function ${PREFIX}MBNormalizeCliPath
  ${Do}
    StrCpy $0 $MBPathNormalized 1
    ${If} $0 != " "
    ${AndIf} $0 != "$\t"
      ${ExitDo}
    ${EndIf}
    StrCpy $MBPathNormalized $MBPathNormalized "" 1
  ${Loop}
  ${Do}
    StrCpy $0 $MBPathNormalized 1 -1
    ${If} $0 != " "
    ${AndIf} $0 != "$\t"
      ${ExitDo}
    ${EndIf}
    StrCpy $MBPathNormalized $MBPathNormalized -1
  ${Loop}
  StrCpy $0 $MBPathNormalized 1
  StrCpy $1 $MBPathNormalized 1 -1
  ${If} $0 == '$\"'
  ${AndIf} $1 == '$\"'
    StrCpy $MBPathNormalized $MBPathNormalized -1 1
  ${EndIf}
  ExpandEnvStrings $MBPathNormalized $MBPathNormalized
  ${Do}
    StrLen $0 $MBPathNormalized
    ${If} $0 <= 3
      ${ExitDo}
    ${EndIf}
    StrCpy $0 $MBPathNormalized 1 -1
    ${If} $0 != "\"
    ${AndIf} $0 != "/"
      ${ExitDo}
    ${EndIf}
    StrCpy $MBPathNormalized $MBPathNormalized -1
  ${Loop}
FunctionEnd

; Counts equivalent entries, but removal selects only the last byte-for-byte
; owned entry. User edits and duplicate entries are never removed wholesale.
Function ${PREFIX}MBScanCliPath
  StrCpy $MBPathMatches 0
  StrCpy $MBPathRemoveStart -1
  StrCpy $MBPathIndex 0
  StrLen $MBPathLength $MBPathValue
  ${Do}
    StrCpy $MBPathStart $MBPathIndex
    ${DoWhile} $MBPathIndex < $MBPathLength
      StrCpy $0 $MBPathValue 1 $MBPathIndex
      ${If} $0 == ";"
        ${ExitDo}
      ${EndIf}
      IntOp $MBPathIndex $MBPathIndex + 1
    ${Loop}
    IntOp $0 $MBPathIndex - $MBPathStart
    StrCpy $MBPathEntry $MBPathValue $0 $MBPathStart
    StrCmpS $MBPathEntry $MBPathOwned 0 mb_path_not_owned
    ${If} $MBPathOwned != ""
      StrCpy $MBPathRemoveStart $MBPathStart
      StrCpy $MBPathRemoveEnd $MBPathIndex
    ${EndIf}
    mb_path_not_owned:
    StrCpy $MBPathNormalized $MBPathEntry
    Call ${PREFIX}MBNormalizeCliPath
    ${If} $MBPathNormalized == $MBPathTarget
      IntOp $MBPathMatches $MBPathMatches + 1
    ${EndIf}
    ${If} $MBPathIndex >= $MBPathLength
      ${ExitDo}
    ${EndIf}
    IntOp $MBPathIndex $MBPathIndex + 1
  ${Loop}
FunctionEnd

Function ${PREFIX}MBRemoveOwnedCliPath
  ${If} $MBPathRemoveStart < 0
    Return
  ${EndIf}
  ${If} $MBPathRemoveStart > 0
    IntOp $MBPathRemoveStart $MBPathRemoveStart - 1
  ${ElseIf} $MBPathRemoveEnd < $MBPathLength
    IntOp $MBPathRemoveEnd $MBPathRemoveEnd + 1
  ${EndIf}
  StrCpy $0 $MBPathValue $MBPathRemoveStart
  StrCpy $1 $MBPathValue "" $MBPathRemoveEnd
  StrCpy $MBPathValue "$0$1"
FunctionEnd

Function ${PREFIX}MBWriteCliPath
  ; Re-read before writing so a concurrent settings change is not overwritten.
  Call ${PREFIX}MBReadCliPath
  StrCmpS $MBPathValue $MBPathBefore 0 mb_path_changed
  ${If} $MBPathSafe != 1
  ${OrIf} $MBPathExists != $MBPathBeforeExists
  ${OrIf} $MBPathType != $MBPathBeforeType
    Goto mb_path_changed
  ${EndIf}
  ClearErrors
  ${If} $MBPathAfter == ""
  ${AndIf} $MBPathMissing == 1
    DeleteRegValue HKCU "${MB_CLI_ENV_REGISTRY_KEY}" "Path"
  ${ElseIf} $MBPathType == 1
    WriteRegStr HKCU "${MB_CLI_ENV_REGISTRY_KEY}" "Path" "$MBPathAfter"
  ${Else}
    WriteRegExpandStr HKCU "${MB_CLI_ENV_REGISTRY_KEY}" "Path" "$MBPathAfter"
  ${EndIf}
  ${If} ${Errors}
    StrCpy $MBPathSafe 0
    DetailPrint "ModelBridge could not update your user PATH. Use bin\modelbridge.cmd from the install folder."
    Return
  ${EndIf}
  !ifndef MB_CLI_SKIP_NOTIFY
    SendMessage 0xffff 0x001A 0 "STR:Environment" /TIMEOUT=2000
  !endif
  Return
  mb_path_changed:
    StrCpy $MBPathSafe 0
    DetailPrint "ModelBridge left your user PATH unchanged because it changed during installation."
FunctionEnd
!macroend

!ifdef BUILD_UNINSTALLER
  !insertmacro MBPathFunctions "un."

  Function un.MBUninstallCliPath
    ReadRegStr $MBPathOwned HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathEntry"
    ${If} $MBPathOwned == ""
      Return
    ${EndIf}
    StrCpy $MBPathInstallEntry "$INSTDIR\bin"
    StrCpy $MBPathNormalized $MBPathInstallEntry
    Call un.MBNormalizeCliPath
    StrCpy $MBPathTarget $MBPathNormalized
    StrCpy $MBPathNormalized $MBPathOwned
    Call un.MBNormalizeCliPath
    ${If} $MBPathTarget != $MBPathNormalized
      Return
    ${EndIf}
    Call un.MBReadCliPath
    ${If} $MBPathSafe != 1
      Return
    ${EndIf}
    StrCpy $MBPathBefore $MBPathValue
    StrCpy $MBPathBeforeType $MBPathType
    StrCpy $MBPathBeforeExists $MBPathExists
    ReadRegDWORD $MBPathMissing HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathMissing"
    Call un.MBScanCliPath
    ${If} $MBPathRemoveStart >= 0
      Call un.MBRemoveOwnedCliPath
      StrCpy $MBPathAfter $MBPathValue
      Call un.MBWriteCliPath
      ${If} $MBPathSafe != 1
        Return
      ${EndIf}
    ${EndIf}
    DeleteRegValue HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathEntry"
    DeleteRegValue HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathMissing"
  FunctionEnd

  !macro customUnInstall
    ; Updates retain ownership until the new installer replaces the old path.
    ${IfNot} ${isUpdated}
      Call un.MBUninstallCliPath
    ${EndIf}
  !macroend
!else
  !insertmacro MBPathFunctions ""

  Function MBInstallCliPath
    Call MBReadCliPath
    ${If} $MBPathSafe != 1
      Return
    ${EndIf}
    StrCpy $MBPathBefore $MBPathValue
    StrCpy $MBPathBeforeType $MBPathType
    StrCpy $MBPathBeforeExists $MBPathExists
    ; A semicolon is legal in a folder name but cannot be a PATH entry.
    StrCpy $MBPathInstallEntry "$INSTDIR\bin"
    StrCpy $MBPathIndex 0
    StrLen $MBPathLength $INSTDIR
    ${DoWhile} $MBPathIndex < $MBPathLength
      StrCpy $0 $INSTDIR 1 $MBPathIndex
      ${If} $0 == ";"
        DetailPrint "ModelBridge cannot add this install folder to PATH because its name contains a semicolon."
        Return
      ${EndIf}
      IntOp $MBPathIndex $MBPathIndex + 1
    ${Loop}
    ReadRegStr $MBPathOwned HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathEntry"
    ReadRegDWORD $MBPathMissing HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathMissing"
    ${If} $MBPathOwned == ""
      IntOp $MBPathMissing $MBPathExists ^ 1
    ${EndIf}
    StrCpy $MBPathNormalized $MBPathInstallEntry
    Call MBNormalizeCliPath
    StrCpy $MBPathTarget $MBPathNormalized
    Call MBScanCliPath
    ${If} $MBPathMatches > 0
    ${AndIf} $MBPathOwned == $MBPathInstallEntry
    ${AndIf} $MBPathRemoveStart >= 0
      Return
    ${EndIf}
    Call MBRemoveOwnedCliPath
    Call MBScanCliPath
    StrCpy $MBPathAfter $MBPathValue
    ${If} $MBPathMatches == 0
      StrLen $0 $MBPathAfter
      StrLen $1 $MBPathInstallEntry
      IntOp $0 $0 + $1
      IntOp $0 $0 + 2
      ${If} $0 >= ${NSIS_MAX_STRLEN}
        DetailPrint "ModelBridge left your user PATH unchanged because adding the install folder would exceed the safe length."
        Return
      ${EndIf}
      ${If} $MBPathAfter == ""
        StrCpy $MBPathAfter $MBPathInstallEntry
      ${Else}
        StrCpy $MBPathAfter "$MBPathAfter;$MBPathInstallEntry"
      ${EndIf}
    ${EndIf}
    StrCmpS $MBPathAfter $MBPathBefore mb_path_record
    Call MBWriteCliPath
    ${If} $MBPathSafe != 1
      Return
    ${EndIf}
    mb_path_record:
    ClearErrors
    ${If} $MBPathMatches == 0
      WriteRegStr HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathEntry" "$MBPathInstallEntry"
      WriteRegDWORD HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathMissing" $MBPathMissing
      ${If} ${Errors}
        DetailPrint "ModelBridge is on PATH, but could not record ownership for automatic removal."
      ${EndIf}
    ${Else}
      ; An existing user-owned entry is reused without claiming ownership.
      DeleteRegValue HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathEntry"
      DeleteRegValue HKCU "${MB_CLI_OWNER_REGISTRY_KEY}" "CliPathMissing"
    ${EndIf}
  FunctionEnd
!endif
!endif
